import fs from 'fs';
import path from 'path';
import tar from 'tar';
import EventEmitter from 'events';
import chalk from 'chalk';
import { rimrafSync } from 'sander';
import {
	WigitError,
	exec,
	fetch,
	mkdirp,
	tryRequire,
	stashFiles,
	unstashFiles,
	wigitConfigName,
	base
} from './utils.js';

const validModes = new Set(['tar', 'git']);

export default function wigit(src, opts) {
	return new Wigit(src, opts);
}

class Wigit extends EventEmitter {
	constructor(src, opts = {}) {
		super();

		this.src = src;
		this.cache = opts.cache;
		this.force = opts.force;
		this.verbose = opts.verbose;
		this.proxy = process.env.https_proxy; // TODO allow setting via --proxy

		this.repo = parse(src);
		this.mode = opts.mode || this.repo.mode;

		if (!validModes.has(this.mode)) {
			throw new Error(`Valid modes are ${Array.from(validModes).join(', ')}`);
		}

		this._hasStashed = false;

		this.directiveActions = {
			clone: async (dir, dest, action) => {
				if (this._hasStashed === false) {
					stashFiles(dir, dest);
					this._hasStashed = true;
				}
				const opts = Object.assign(
					{ force: true },
					{ cache: action.cache, verbose: action.verbose }
				);
				const d = wigit(action.src, opts);

				d.on('info', event => {
					console.error(
						chalk.cyan(`> ${event.message.replace('options.', '--')}`)
					);
				});

				d.on('warn', event => {
					console.error(
						chalk.magenta(`! ${event.message.replace('options.', '--')}`)
					);
				});

				await d.clone(dest).catch(err => {
					console.error(chalk.red(`! ${err.message}`));
					process.exit(1);
				});
			},
			remove: this.remove.bind(this)
		};
	}

	_getDirectives(dest) {
		const directivesPath = path.resolve(dest, wigitConfigName);
		const directives =
			tryRequire(directivesPath, { clearCache: true }) || false;
		if (directives) {
			fs.unlinkSync(directivesPath);
		}

		return directives;
	}

	async clone(dest) {
		this._checkDirIsEmpty(dest);

		const { repo } = this;
		const dir = path.join(base, repo.site, repo.user, repo.name);
		if (this.mode === 'tar') {
			await this._cloneWithTar(dir, dest);
		} else {
			await this._cloneWithGit(dir, dest);
		}
		this._success({
			code: 'SUCCESS',
			message: `cloned ${chalk.bold(repo.user + '/' + repo.name)}#${chalk.bold(
				repo.ref
			)}${dest !== '.' ? ` to ${dest}` : ''}`,
			repo,
			dest
		});

		const directives = this._getDirectives(dest);
		if (directives) {
			for (const d of directives) {
				// TODO, can this be a loop with an index to pass for better error messages?
				await this.directiveActions[d.action](dir, dest, d);
			}
			if (this._hasStashed === true) {
				unstashFiles(dir, dest);
			}
		}
	}

	remove(dir, dest, action) {
		let files = action.files;
		if (!Array.isArray(files)) {
			files = [files];
		}
		const removedFiles = files
			.map(file => {
				const filePath = path.resolve(dest, file);
				if (fs.existsSync(filePath)) {
					const isDir = fs.lstatSync(filePath).isDirectory();
					if (isDir) {
						rimrafSync(filePath);
						return file + '/';
					} else {
						fs.unlinkSync(filePath);
						return file;
					}
				} else {
					this._warn({
						code: 'FILE_DOES_NOT_EXIST',
						message: `action wants to remove ${chalk.bold(
							file
						)} but it does not exist`
					});
					return null;
				}
			})
			.filter(d => d);

		if (removedFiles.length > 0) {
			this._info({
				code: 'REMOVED',
				message: `removed: ${chalk.bold(
					removedFiles.map(d => chalk.bold(d)).join(', ')
				)}`
			});
		}
	}

	_checkDirIsEmpty(dir) {
		try {
			const files = fs.readdirSync(dir);
			if (files.length > 0) {
				if (this.force) {
					this._info({
						code: 'DEST_NOT_EMPTY',
						message: `destination directory is not empty. Using options.force, continuing`
					});
				} else {
					throw new WigitError(
						`destination directory is not empty, aborting. Use options.force to override`,
						{
							code: 'DEST_NOT_EMPTY'
						}
					);
				}
			} else {
				this._verbose({
					code: 'DEST_IS_EMPTY',
					message: `destination directory is empty`
				});
			}
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
	}

	_info(info) {
		this.emit('info', info);
	}

	_warn(info) {
		this.emit('warn', info);
	}
	_error(info) {
		this.emit('error', info);
	}
	_success(info) {
		this.emit('success', info);
	}
	_verbose(info) {
		if (this.verbose) this._info(info);
	}
	
	async _getHash(repo, cached) {
		try {
			const refs = await fetchRefs(repo);
			if (repo.ref === 'HEAD') {
				return refs.find(ref => ref.type === 'HEAD').hash;
			}
			return this._selectRef(refs, repo.ref);
		} catch (err) {
			this._warn(err);
			this._verbose(err.original);

			return this._getHashFromCache(repo, cached);
		}
	}

	_getHashFromCache(repo, cached) {
		if (repo.ref in cached) {
			const hash = cached[repo.ref];
			this._info({
				code: 'USING_CACHE',
				message: `using cached commit hash ${hash}`
			});
			return hash;
		}
	}

	_selectRef(refs, selector) {
		for (const ref of refs) {
			if (ref.name === selector) {
				this._verbose({
					code: 'FOUND_MATCH',
					message: `found matching commit hash: ${ref.hash}`
				});
				return ref.hash;
			}
		}

		if (selector.length < 8) return null;

		for (const ref of refs) {
			if (ref.hash.startsWith(selector)) return ref.hash;
		}
	}

	async _cloneWithTar(dir, dest) {
		const { repo } = this;

		const cached = tryRequire(path.join(dir, 'map.json')) || {};

		const hash = this.cache
			? this._getHashFromCache(repo, cached)
			: await this._getHash(repo, cached);

		const subdir = repo.subdir ? `${repo.name}-${hash}${repo.subdir}` : null;

		if (!hash) {
			// TODO 'did you mean...?'
			throw new WigitError(`could not find commit hash for ${repo.ref}`, {
				code: 'MISSING_REF',
				ref: repo.ref
			});
		}

		const file = `${dir}/${hash}.tar.gz`;
		const url =
			repo.site === 'gitlab.com'
				? `${repo.url}/repository/archive.tar.gz?ref=${hash}`
				: repo.site === 'bitbucket.org'
				? `${repo.url}/get/${hash}.tar.gz`
				: `${repo.url}/archive/${hash}.tar.gz`;

		try {
			if (!this.cache) {
				try {
					fs.statSync(file);
					this._verbose({
						code: 'FILE_EXISTS',
						message: `${file} already exists locally`
					});
				} catch (err) {
					mkdirp(path.dirname(file));

					if (this.proxy) {
						this._verbose({
							code: 'PROXY',
							message: `using proxy ${this.proxy}`
						});
					}

					this._verbose({
						code: 'DOWNLOADING',
						message: `downloading ${url} to ${file}`
					});
					await fetch(url, file, this.proxy, repo.protocol);
					updateCache(dir, repo, hash, cached);

					this._verbose({
						code: 'EXTRACTING',
						message: `extracting ${
							subdir ? repo.subdir + ' from ' : ''
						}${file} to ${dest}`
					});

					mkdirp(dest);
					await untar(file, dest, subdir);
				}
			}
		} catch (err) {
			this._warn({
				code: 'warn',
				message: `download ${chalk.bold(url)} failed, automatically downgrade "git clone"`,
				repo,
				dest
			});
			await this._cloneWithGithttp(dir, dest);
		}

		
	}

	async _cloneWithGit(dir, dest) {
		console.log(`git clone ${this.repo.ssh} ${dest}`);
		await exec(`git clone ${this.repo.ssh} ${dest}`);
		console.log(`rm -rf ${path.resolve(dest, '.git')}`);
		await exec(`rm -rf ${path.resolve(dest, '.git')}`);
	}
	async _cloneWithGithttp(dir, dest) {
		console.log(`git clone ${this.repo.url}.git ${dest}`);
		await exec(`git clone ${this.repo.url}.git ${dest}`);
		console.log(`rm -rf ${path.resolve(dest, '.git')}`);
		await exec(`rm -rf ${path.resolve(dest, '.git')}`);
	}
}

const supported = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'git.sr.ht', 'git.srv.ourwill.cn']);

function parse(src) {
	const match = /^(?:(?:(http|https):\/\/)?([^:/]+\.[^:/]+)\/|git@([^:/]+)[:/]|([^/]+):)?([^/\s]+)\/([^/\s#]+)(?:((?:\/[^/\s#]+)+))?(?:\/)?(?:#(.+))?/.exec(
		src
	);
	if (!match) {
		throw new WigitError(`could not parse ${src}`, {
			code: 'BAD_SRC'
		});
	}
	const site = (match[2] || match[3] || match[4] || 'git.srv.ourwill.cn')
	// const site = domain.replace(
	// 	/\.(com|org|cn)$/,
	// 	''
	// );
	if (!supported.has(site)) {
		throw new WigitError(
			`wigit supports GitHub, GitLab, Sourcehut and BitBucket, receive ${site}`,
			{
				code: 'UNSUPPORTED_HOST'
			}
		);
	}
	const protocol = match[1] || 'http';
	const user = match[5];
	const name = match[6].replace(/\.git$/, '');
	const subdir = match[7];
	const ref = match[8] || 'HEAD';

	// const domain = `${label}.${
	// 	label === 'bitbucket' ? 'org' : site === 'git.sr.ht' ? '' : 'com'
	// }`;
	const url = `${protocol}://${site}/${user}/${name}`;
	const ssh = `git@${site}:${user}/${name}`;

	const mode = supported.has(site) ? 'tar' : 'git';

	return { protocol, site, user, name, ref, url, ssh, subdir, mode };
}

async function untar(file, dest, subdir = null) {
	return tar.extract(
		{
			file,
			strip: subdir ? subdir.split('/').length : 1,
			C: dest
		},
		subdir ? [subdir] : []
	);
}

async function fetchRefs(repo) {
	try {
		const { stdout } = await exec(`git ls-remote ${repo.url}`);

		return stdout
			.split('\n')
			.filter(Boolean)
			.map(row => {
				const [hash, ref] = row.split('\t');

				if (ref === 'HEAD') {
					return {
						type: 'HEAD',
						hash
					};
				}

				const match = /refs\/(\w+)\/(.+)/.exec(ref);
				if (!match)
					throw new WigitError(`could not parse ${ref}`, {
						code: 'BAD_REF'
					});

				return {
					type:
						match[1] === 'heads'
							? 'branch'
							: match[1] === 'refs'
							? 'ref'
							: match[1],
					name: match[2],
					hash
				};
			});
	} catch (error) {
		throw new WigitError(`could not fetch remote ${repo.url}`, {
			code: 'COULD_NOT_FETCH',
			url: repo.url,
			original: error
		});
	}
}

function updateCache(dir, repo, hash, cached) {
	// update access logs
	console.log(dir, repo, hash, cached);
	const logs = tryRequire(path.join(dir, 'access.json')) || {};
	logs[repo.ref] = new Date().toISOString();
	fs.writeFileSync(
		path.join(dir, 'access.json'),
		JSON.stringify(logs, null, '  ')
	);

	if (cached[repo.ref] === hash) return;

	const oldHash = cached[repo.ref];
	if (oldHash) {
		let used = false;
		for (const key in cached) {
			if (cached[key] === hash) {
				used = true;
				break;
			}
		}

		if (!used) {
			// we no longer need this tar file
			try {
				fs.unlinkSync(path.join(dir, `${oldHash}.tar.gz`));
			} catch (err) {
				// ignore
			}
		}
	}

	cached[repo.ref] = hash;
	fs.writeFileSync(
		path.join(dir, 'map.json'),
		JSON.stringify(cached, null, '  ')
	);
}
