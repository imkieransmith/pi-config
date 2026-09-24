/**
 * Confirm Pi tool calls that could destroy work git can't restore.
 *
 *   - Covers write overwrites, large edit removals, and destructively-named
 *     custom tools. Bash is not checked: the sandbox (./sandbox/)
 *     keeps it inside the project with `.git` read-only.
 *   - Edits to tracked files skip size-based prompts, even with uncommitted
 *     changes. Full overwrites keep their stricter checks.
 *   - Confirmations share a per-session allow-list via ./shared/confirm-gate.
 *
 * Original - https://github.com/spences10/my-pi/tree/main/packages/pi-confirm-destructive
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { resolveSecurityPath } from './security/policy.ts';
import { installSessionAllowReset, requestSessionConfirm } from './shared/confirm-gate.js';

export interface DestructiveAction {
	title: string;
	description: string;
	reason: string;
	allow_key: string;
}

const DESTRUCTIVE_CUSTOM_TOOL_NAME =
	/(^|[_-])(delete|destroy|drop|remove|archive|execute_write_query|execute_schema_query|bulk_insert)([_-]|$)/i;

function preview(value: string, max = 500): string {
	const normalized = value.trim().replace(/\s+/g, ' ');
	return normalized.length > max
		? `${normalized.slice(0, max - 1)}…`
		: normalized;
}

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8', timeout: 2000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch { return undefined; }
}
async function is_git_repo(cwd: string): Promise<boolean> {
  return await git(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
}

type GitRecoverability =
	| 'tracked-clean'
	| 'tracked-dirty'
	| 'untracked'
	| 'not-git';

async function get_git_recoverability(
	cwd: string,
	path: string,
): Promise<GitRecoverability> {
	if (!await is_git_repo(cwd)) return 'not-git';

	const status = await git(['status', '--porcelain=v1', '--', path], cwd);
	if (status === undefined) return 'not-git';
	if (status.length > 0) {
		return status.split('\n').some((line) => line.startsWith('??'))
			? 'untracked'
			: 'tracked-dirty';
	}

	const tracked = await git(['ls-files', '--', path], cwd);
	return tracked ? 'tracked-clean' : 'untracked';
}

async function is_git_recoverable(cwd: string, path: string): Promise<boolean> {
	return await get_git_recoverability(cwd, path) === 'tracked-clean';
}

async function is_git_tracked(absolute: string): Promise<boolean> {
	// Edit policy trusts tracked files, including uncommitted work. Resolve the
	// actual file's repository and treat its name literally, not as a path pattern.
	return await git([
		'--literal-pathspecs', 'ls-files', '--error-unmatch', '--', absolute,
	], dirname(absolute)) !== undefined;
}

function is_todo_planning_note(path: string): boolean {
	return basename(path).toLowerCase() === 'todo.md';
}

async function assess_file_write(
	cwd: string,
	path: unknown,
	session_created_paths: ReadonlySet<string> = new Set(),
): Promise<DestructiveAction | undefined> {
	if (typeof path !== 'string' || !path.trim()) return undefined;
	if (is_todo_planning_note(path)) return undefined;
	const absolute = await resolveSecurityPath(path, cwd);
	if (!existsSync(absolute)) return undefined;
	if (session_created_paths.has(absolute)) return undefined;
	if (await is_git_recoverable(cwd, path)) return undefined;

	const reason =
		await get_git_recoverability(cwd, path) === 'tracked-dirty'
			? 'Overwrites a file with uncommitted changes'
			: 'Overwrites an untracked file git cannot restore';

	return {
		title: 'Confirm file overwrite?',
		description: `${reason}: ${path}`,
		reason,
		allow_key: 'write:risky-overwrite',
	};
}

async function assess_file_edit(
	cwd: string,
	input: Record<string, unknown>,
	session_created_paths: ReadonlySet<string> = new Set(),
): Promise<DestructiveAction | undefined> {
	const path =
		typeof input.path === 'string' ? input.path : undefined;
	const edits = Array.isArray(input.edits) ? input.edits : [];
	let removed_chars = 0;
	let added_chars = 0;

	for (const edit of edits) {
		if (!edit || typeof edit !== 'object') continue;
		const old_text = (edit as { oldText?: unknown }).oldText;
		const new_text = (edit as { newText?: unknown }).newText;
		if (typeof old_text === 'string')
			removed_chars += old_text.length;
		if (typeof new_text === 'string') added_chars += new_text.length;
	}

	if (removed_chars === 0 || removed_chars - added_chars < 200) {
		return undefined;
	}
	if (path) {
		if (is_todo_planning_note(path)) return undefined;
		const absolute = await resolveSecurityPath(path, cwd);
		if (session_created_paths.has(absolute) || await is_git_tracked(absolute)) return undefined;
	}

	return {
		title: 'Confirm large content removal?',
		description: `This edit removes ${removed_chars - added_chars} more characters than it adds${path ? ` in ${path}` : ''}.`,
		reason: path
			? 'Removes substantial content from an untracked or unchecked file'
			: 'Removes substantial file content',
		allow_key: 'edit:large-removal-risky',
	};
}

function assess_custom_tool(
	event: ToolCallEvent,
): DestructiveAction | undefined {
	if (!DESTRUCTIVE_CUSTOM_TOOL_NAME.test(event.toolName)) {
		return undefined;
	}

	const input = event.input as Record<string, unknown>;
	const query =
		typeof input.query === 'string'
			? `\n\nQuery: ${preview(input.query)}`
			: '';

	return {
		title: 'Confirm destructive tool call?',
		description: `Tool ${event.toolName} appears destructive.${query}`,
		reason: `Potentially destructive tool: ${event.toolName}`,
		allow_key: `tool:${event.toolName}`,
	};
}

export async function assess_tool_call(
	event: ToolCallEvent,
	cwd: string,
	session_created_paths: ReadonlySet<string> = new Set(),
): Promise<DestructiveAction | undefined> {
	if (event.toolName === 'write') {
		return assess_file_write(
			cwd,
			event.input.path,
			session_created_paths,
		);
	}
	if (event.toolName === 'edit') {
		return assess_file_edit(cwd, event.input, session_created_paths);
	}
	return assess_custom_tool(event);
}

function blocked_reason(action: DestructiveAction): string {
	return `Blocked destructive action: ${action.reason}`;
}

export default async function confirm_destructive(pi: ExtensionAPI) {
	installSessionAllowReset(pi);

	const pending_created_files = new Map<string, string>();
	const session_created_files = new Set<string>();
  pi.on('session_start', () => { pending_created_files.clear(); session_created_files.clear(); });
  pi.on('session_shutdown', () => { pending_created_files.clear(); session_created_files.clear(); });

	// 3-way confirm with a per-session allow-list shared with security.ts.
	async function should_allow(
		action: DestructiveAction,
		ctx: ExtensionContext,
	): Promise<boolean> {
		const outcome = await requestSessionConfirm(
			ctx,
			{ title: action.title, detail: action.description, allowKey: action.allow_key },
			blocked_reason(action),
		);
		return outcome.allow;
	}

	pi.on(
		'tool_call',
		async (
			event: ToolCallEvent,
			ctx,
		): Promise<ToolCallEventResult | void> => {
			if (event.toolName === 'write') {
				const path = event.input.path;
				if (typeof path === 'string' && path.trim()) {
					const absolute = await resolveSecurityPath(path, ctx.cwd);
					if (!existsSync(absolute)) {
						pending_created_files.set(event.toolCallId, absolute);
					}
				}
			}

			const action = await assess_tool_call(
				event,
				ctx.cwd,
				session_created_files,
			);
			if (!action) return;

			if (await should_allow(action, ctx)) return;

			return {
				block: true,
				reason: blocked_reason(action),
			};
		},
	);

	pi.on(
		'tool_result',
		async (event: ToolResultEvent): Promise<void> => {
			const absolute = pending_created_files.get(event.toolCallId);
			if (!absolute) return;
			pending_created_files.delete(event.toolCallId);
			if (event.toolName === 'write' && !event.isError) {
				session_created_files.add(absolute);
			}
		},
	);
}
