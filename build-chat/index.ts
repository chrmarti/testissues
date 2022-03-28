#!/usr/bin/env ts-node

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest'
import { buildChat } from './BuildChat'

/*
export ado_user="$(az keyvault secret show --vault-name vscode-probot --name monacotools-builds-user --query value --output tsv)"
export ado_pass="$(az keyvault secret show --vault-name vscode-probot --name monacotools-builds-token --query value --output tsv)"
# export slack_token="$(az keyvault secret show --vault-name vscode-probot --name slack-api-token --query value --output tsv)"
export storage_connection_string="$(az keyvault secret show --vault-name vscode-probot --name azure-storage-connection --query value --output tsv)"
export workflow_run_url="https://dev.azure.com/monacotools/a6d41577-0fa3-498e-af22-257312ff0545/_apis/build/Builds/163530" # succeed > fail
export notify_authors=false
export notification_channel=bottest
export log_channel=bot-log
export console_log=true
./index.ts
*/

export async function run() {
	const githubToken = getInput('token') || getInput('github_token')
	const octokit = githubToken ? new Octokit({ auth: githubToken }) : new Octokit()
	const user = getInput('ado_user')
	const pass = getInput('ado_pass')
	await buildChat(octokit, getRequiredInput('workflow_run_url'), {
		adoAuth: user && pass ? { user, pass } : undefined,
		slackToken: getInput('slack_token') || undefined,
		storageConnectionString: getInput('storage_connection_string') || undefined,
		notifyAuthors: getInput('notify_authors') === 'true',
		notificationChannel: getInput('notification_channel') || undefined,
		logChannel: getInput('log_channel') || undefined,
		consoleLog: getInput('console_log') === 'true',
	})
}

function getInput(name: string) {
	return process.env[name];
}

function getRequiredInput(name: string) {
	const value = getInput(name)
	if (value === undefined) {
		throw new Error(`Missing input: ${name}`)
	}
	return value;
}

run()
	.catch(console.error);