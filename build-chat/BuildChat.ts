/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest'
import { WebClient } from '@slack/web-api'
import { BlobServiceClient } from '@azure/storage-blob'
import * as request from 'request-promise';

export const safeLog = (message: string, ...args: (string | number | string[])[]): void => {
	const clean = (val: any) => ('' + val).replace(/:|#/g, '')
	console.log(clean(message), ...args.map(clean))
}

export interface Options {
	adoAuth?: { user: string; pass: string }
	slackToken?: string
	storageConnectionString?: string
	notifyAuthors?: boolean
	notificationChannel?: string
	logChannel?: string
	consoleLog?: boolean;
}

interface UserOrChannel {
	id: string
	name: string
}

interface Team {
	members: UserOrChannel[]
}

export async function buildChat(octokit: Octokit, buildUrl: string, options: Options = {}) {
	const results = await buildComplete(octokit, buildUrl, options)
	if (options.slackToken && (results.logMessages.length || results.messages.length)) {
		const web = new WebClient(options.slackToken)
		const memberships = await listAllMemberships(web)

		const logChannel = options.logChannel && memberships.find((m) => m.name === options.logChannel)
		if (options.logChannel && !logChannel) {
			safeLog(`Log channel not found: ${options.logChannel}`)
		}
		if (logChannel) {
			for (const logMessage of results.logMessages) {
				await web.chat.postMessage({
					text: logMessage,
					link_names: true,
					channel: logChannel.id,
					as_user: true,
				})
			}
		}

		const usersByName: Record<string, UserOrChannel> = {}
		if (options.notifyAuthors) {
			for await (const page of web.paginate('users.list')) {
				for (const member of ((page as unknown) as Team).members) {
					usersByName[member.name] = member
				}
			}
		}

		const notificationChannel =
			options.notificationChannel && memberships.find((m) => m.name === options.notificationChannel)
		if (options.notificationChannel && !notificationChannel) {
			safeLog(`Notification channel not found: ${options.notificationChannel}`)
		}
		for (const message of results.messages) {
			const notificationChannels: UserOrChannel[] = []
			if (logChannel) {
				notificationChannels.push(logChannel)
			}
			if (notificationChannel) {
				notificationChannels.push(notificationChannel)
			}
			if (options.notifyAuthors) {
				for (const slackAuthor of message.slackAuthors) {
					const user = usersByName[slackAuthor]
					if (user) {
						const channel = (
							await web.conversations.open({
								users: user.id,
							})
						).channel as UserOrChannel
						notificationChannels.push(channel)
					} else {
						safeLog(`Slack user not found: ${slackAuthor}`)
					}
				}
			}

			for (const channel of notificationChannels) {
				await web.chat.postMessage({
					text: message.text,
					link_names: true,
					channel: channel.id,
					as_user: true,
				})
			}
		}
	}
	if (options.consoleLog) {
		for (const message of results.logMessages) {
			safeLog(message)
		}
		for (const message of results.messages) {
			safeLog(message.text)
		}
	}
}

interface BuildResult {
	_links: {
		web: {
			href: string;
		},
		timeline: {
			href: string;
		}
	}
	id: number,
	url: string;
	status: string;
	result: string;
	queueTime: string;
	startTime: string;
	finishTime: string;
	sourceBranch: string;
	sourceVersion: string;
	repository: {
		id: string;
		type: string;
	};
	requestedBy: User,
	definition: {
		id: number;
		name: string;
		url: string;
	};
}

interface ListOf<T> {
	count: number;
	value: T[];
}

interface User {
	displayName: string;
	uniqueName: string;
}

interface Build {
	id: number;
	repository: string;
	branch: string;
	sourceVersion: string;
	previousSourceVersion?: string;
	result: string;
	degraded?: boolean;
	authors: string[];
	requester: User;
	buildHtmlUrl: string;
	changesHtmlUrl: string;
	queueTime: string;
	startTime: string;
	finishTime: string;
}

const results = ['succeeded', 'partiallySucceeded', 'failed']

async function buildComplete(octokit: Octokit, buildUrl: string, options: Options = {}) {
	safeLog(`buildComplete: ${buildUrl}`);
	const monacotools = buildUrl.startsWith('https://monacotools.visualstudio.com/') || buildUrl.startsWith('https://dev.azure.com/monacotools/');
	const lastSegmentIndex = buildUrl.lastIndexOf('/');
	const buildsApiUrl = buildUrl.substr(0, lastSegmentIndex);
	const buildResult: BuildResult = await request({ uri: buildUrl, auth: options.adoAuth, json: true });
	if (!buildResult.sourceBranch || (
		buildResult.sourceBranch !== 'refs/heads/main'
		&& !buildResult.sourceBranch.startsWith('refs/heads/release/')
		&& buildResult.sourceBranch !== 'refs/heads/remote-hackathon'
	)) {
		return { logMessages: [], messages: [] };
	}
	const buildQuery = `${buildsApiUrl}?$top=10&maxTime=${buildResult.finishTime}&definitions=${buildResult.definition.id}&branchName=${buildResult.sourceBranch}&resultFilter=${results.join(',')}&api-version=5.0-preview.4`;
	const buildResults: ListOf<BuildResult> = await request({ uri: buildQuery, auth: options.adoAuth, json: true });
	buildResults.value.sort((a, b) => -a.startTime.localeCompare(b.startTime)); // TODO: Retry using queryOrder parameter.
	const currentBuildIndex = buildResults.value.findIndex(build => build.id === buildResult.id);
	if (currentBuildIndex === -1) {
		return { logMessages: [], messages: [] };
	}
	const slicedResults = buildResults.value.slice(currentBuildIndex, currentBuildIndex + 2);
	const builds = slicedResults
		.map<Build>((build, i, array) => ({
			id: build.id,
			repository: build.repository.id,
			branch: build.sourceBranch.substr('refs/heads/'.length),
			sourceVersion: build.sourceVersion,
			previousSourceVersion: i < array.length - 1 ? array[i + 1].sourceVersion : undefined,
			result: build.result,
			authors: [],
			requester: build.requestedBy,
			buildHtmlUrl: build._links.web.href,
			changesHtmlUrl: '',
			queueTime: build.queueTime,
			startTime: build.startTime,
			finishTime: build.finishTime,
		}));
	const logMessages = builds.slice(0, 1)
		.map(build => `Id: ${build.id} | Branch: ${build.branch} | Result: ${build.result} | Queue: ${build.queueTime} | Start: ${build.startTime} | Finish: ${build.finishTime}`);
	const transitionedBuilds = builds.filter((build, i, array) => i < array.length - 1 && transitioned(build, array[i + 1]));
	await Promise.all(transitionedBuilds
		.map(async build => {
			if (build.previousSourceVersion) {
				if (buildResult.sourceBranch === 'refs/heads/remote-hackathon') {
					build.authors = ['TBD', 'chrmarti'];
				} else {
					const repo = build.repository.split('/');
					const cmp = await compareCommits(octokit, repo[0], repo[1], build.previousSourceVersion, build.sourceVersion);
					const commits = cmp.data.commits;
					const authors = new Set<string>([
						...commits.map((c: any) => c.author.login),
						...commits.map((c: any) => c.committer.login),
					]);
					authors.delete('web-flow'); // GitHub Web UI committer
					build.authors = [...authors];
				}
				build.changesHtmlUrl = `https://github.com/${build.repository}/compare/${build.previousSourceVersion.substr(0, 7)}...${build.sourceVersion.substr(0, 7)}`; // Shorter than: cmp.data.html_url
			}
		}));
	const vscode = buildResult.definition.name === 'VS Code';
	const releaseBuild = monacotools && vscode;
	const name = vscode ? `VS Code ${releaseBuild ? 'Release' : 'Continuous'} Build` : buildResult.definition.name;
	const accounts = await readAccounts(options.storageConnectionString);
	const githubAccountMap = githubToAccounts(accounts);
	const vstsAccountMap = vstsToAccounts(accounts);
	const messages = transitionedBuilds.map(build => {
		return {
			text: `${name}
Result: ${build.result} | Branch: ${build.branch} | Requester: ${vstsToSlackUser(vstsAccountMap, build.requester, build.degraded)} | Authors: ${githubToSlackUsers(githubAccountMap, build.authors, build.degraded).sort().join(', ') || 'None (rebuild)'}
[Build](${build.buildHtmlUrl}) | [Changes](${build.changesHtmlUrl})`,
			slackAuthors: build.authors.map((a) => githubAccountMap[a]?.slack).filter((a) => !!a),
		}
	});
	return { logMessages, messages };
}

function transitioned(newer: Build, older: Build) {
	if (newer.result === older.result) {
		return false;
	}
	if (results.indexOf(newer.result) > results.indexOf(older.result)) {
		newer.degraded = true;
	}
	return true;
}

async function compareCommits(octokit: Octokit, owner: string, repo: string, base: string, head: string) {
	return octokit.repos.compareCommits({ owner, repo, base, head })
}

function githubToSlackUsers(githubToAccounts: Record<string, Accounts>, githubUsers: string[], at?: boolean) {
	return githubUsers.map((g) => (githubToAccounts[g] ? `${at ? '@' : ''}${githubToAccounts[g].slack}` : g))
}

function vstsToAccounts(accounts: Accounts[]) {
	return accounts.reduce((m, e) => {
		m[e.vsts] = e;
		return m;
	}, <Record<string, Accounts>>{});
}

function vstsToSlackUser(vstsToAccounts: Record<string, Accounts>, vstsUser: User, at?: boolean) {
	if (vstsUser.displayName === 'Microsoft.VisualStudio.Services.TFS' || vstsUser.displayName === 'GitHub') {
		return 'Scheduled';
	}
	return vstsToAccounts[vstsUser.uniqueName] ? `${at ? '@' : ''}${vstsToAccounts[vstsUser.uniqueName].slack}` : vstsUser.uniqueName;
}

interface Accounts {
	github: string
	slack: string
	vsts: string
}

function githubToAccounts(accounts: Accounts[]) {
	return accounts.reduce((m, e) => {
		m[e.github] = e
		return m
	}, <Record<string, Accounts>>{})
}

async function readAccounts(connectionString: string | undefined) {
	if (!connectionString) {
		safeLog('Connection string missing.')
		return []
	}
	const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString)
	const containerClient = blobServiceClient.getContainerClient('config')
	const createContainerResponse = containerClient.getBlockBlobClient('accounts.json')
	const buf = await createContainerResponse.downloadToBuffer()
	return JSON.parse(buf.toString()) as Accounts[]
}

interface Channel {
	id: string
	name: string
	is_member: boolean
}

interface ConversationsList {
	channels: Channel[]
	response_metadata?: {
		next_cursor?: string
	}
}

async function listAllMemberships(web: WebClient) {
	let groups: ConversationsList | undefined
	const channels: Channel[] = []
	do {
		groups = ((await web.conversations.list({
			types: 'public_channel,private_channel',
			cursor: groups?.response_metadata?.next_cursor,
			limit: 100,
		})) as unknown) as ConversationsList
		channels.push(...groups.channels)
	} while (groups.response_metadata?.next_cursor)
	return channels.filter((c) => c.is_member)
}
