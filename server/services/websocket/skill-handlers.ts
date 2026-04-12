// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSkillsDir } from '../../utils/paths.js';
import type { HandlerContext } from './handler-context.js';
import type { SkillEntry, WSContext } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_AGENTS_DIR = join(__dirname, '..', 'plan', 'agents');
const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills');

const PLATFORM_COMMANDS: SkillEntry[] = [
	{
		name: 'board',
		displayName: '/board',
		description: 'Convert the current chat conversation into a PM board with issues.',
		source: 'platform',
	},
	{
		name: 'ship',
		displayName: '/ship',
		description: 'Convert chat into a PM board and auto-implement with AI agents.',
		source: 'platform',
	},
];

function parseFrontmatter(content: string): Record<string, string> {
	if (!content.startsWith('---')) return {};
	const endIdx = content.indexOf('---', 3);
	if (endIdx === -1) return {};
	const yaml = content.slice(3, endIdx).trim();
	const result: Record<string, string> = {};
	for (const line of yaml.split('\n')) {
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let val = line.slice(colonIdx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		result[key] = val;
	}
	return result;
}

function scanProjectSkills(skillsDir: string): SkillEntry[] {
	if (!existsSync(skillsDir)) return [];
	const entries: SkillEntry[] = [];
	for (const name of readdirSync(skillsDir, { withFileTypes: true })) {
		if (!name.isDirectory()) continue;
		const skillFile = join(skillsDir, name.name, 'SKILL.md');
		if (!existsSync(skillFile)) continue;
		try {
			const content = readFileSync(skillFile, 'utf-8');
			const fm = parseFrontmatter(content);
			if (fm['user-invocable'] === 'false') continue;
			entries.push({
				name: fm.name || name.name,
				displayName: `/${fm.name || name.name}`,
				description: fm.description || '',
				source: 'project',
			});
		} catch { /* skip unreadable files */ }
	}
	return entries;
}

function tryReadSkill(skillFile: string): Record<string, string> | null {
	if (!existsSync(skillFile)) return null;
	try {
		return parseFrontmatter(readFileSync(skillFile, 'utf-8'));
	} catch { return null; }
}

function scanUserSkills(userSkillsDir: string, seen: Set<string>): SkillEntry[] {
	if (!existsSync(userSkillsDir)) return [];
	const entries: SkillEntry[] = [];
	for (const name of readdirSync(userSkillsDir, { withFileTypes: true })) {
		if (!name.isDirectory() || seen.has(name.name)) continue;
		const fm = tryReadSkill(join(userSkillsDir, name.name, 'SKILL.md'));
		if (!fm || fm['user-invocable'] === 'false') continue;
		const skillName = fm.name || name.name;
		if (seen.has(skillName)) continue;
		entries.push({
			name: skillName,
			displayName: `/${skillName}`,
			description: fm.description || '',
			source: 'user',
		});
	}
	return entries;
}

function scanSystemAgents(agentsDir: string, seen: Set<string>): SkillEntry[] {
	if (!existsSync(agentsDir)) return [];
	const entries: SkillEntry[] = [];
	for (const file of readdirSync(agentsDir)) {
		if (!file.endsWith('.md')) continue;
		const name = file.replace(/\.md$/, '');
		if (seen.has(name)) continue;
		try {
			const content = readFileSync(join(agentsDir, file), 'utf-8');
			const fm = parseFrontmatter(content);
			if (fm['user-invocable'] === 'false') continue;
			entries.push({
				name: fm.name || name,
				displayName: `/${fm.name || name}`,
				description: fm.description || '',
				source: 'system',
			});
		} catch { /* skip unreadable files */ }
	}
	return entries;
}

export function handleListSkills(ctx: HandlerContext, ws: WSContext, workingDir: string): void {
	const skills: SkillEntry[] = [...PLATFORM_COMMANDS];
	const seen = new Set(skills.map(s => s.name));

	const projectSkillsDir = findSkillsDir(workingDir);
	if (projectSkillsDir) {
		const projectSkills = scanProjectSkills(projectSkillsDir);
		for (const s of projectSkills) {
			if (!seen.has(s.name)) {
				skills.push(s);
				seen.add(s.name);
			}
		}
	}

	skills.push(...scanUserSkills(USER_SKILLS_DIR, seen));

	for (const s of skills) seen.add(s.name);
	skills.push(...scanSystemAgents(SYSTEM_AGENTS_DIR, seen));

	skills.sort((a, b) => a.name.localeCompare(b.name));
	ctx.send(ws, { type: 'skillsList', data: { skills } });
}

/**
 * Extract prompt content from a SKILL.md file (everything after the frontmatter).
 */
function extractSkillContent(fileContent: string): string {
	if (!fileContent.startsWith('---')) return fileContent;
	const endIdx = fileContent.indexOf('---', 3);
	if (endIdx === -1) return fileContent;
	return fileContent.slice(endIdx + 3).trim();
}

interface SkillFile {
	content: string;
	skillDir: string;
}

/**
 * Find and read a skill's SKILL.md by name. Checks project skills first, then system agents.
 * Returns the raw file content and the skill directory, or null if not found.
 */
function findSkillContent(skillName: string, workingDir: string): SkillFile | null {
	// Project skills: .claude/skills/<name>/SKILL.md
	const projectSkillsDir = findSkillsDir(workingDir);
	if (projectSkillsDir) {
		const skillDir = join(projectSkillsDir, skillName);
		const skillFile = join(skillDir, 'SKILL.md');
		if (existsSync(skillFile)) {
			try {
				return { content: readFileSync(skillFile, 'utf-8'), skillDir };
			} catch { /* fall through */ }
		}
	}

	// User skills: ~/.claude/skills/<name>/SKILL.md
	const userSkillDir = join(USER_SKILLS_DIR, skillName);
	const userSkillFile = join(userSkillDir, 'SKILL.md');
	if (existsSync(userSkillFile)) {
		try {
			return { content: readFileSync(userSkillFile, 'utf-8'), skillDir: userSkillDir };
		} catch { /* fall through */ }
	}

	// System agents: <agents-dir>/<name>.md
	const agentFile = join(SYSTEM_AGENTS_DIR, `${skillName}.md`);
	if (existsSync(agentFile)) {
		try {
			return { content: readFileSync(agentFile, 'utf-8'), skillDir: SYSTEM_AGENTS_DIR };
		} catch { /* fall through */ }
	}

	return null;
}

/**
 * Fill in {{mustache}} template variables in skill content.
 */
function fillTemplateVariables(content: string, vars: Record<string, string>): string {
	let result = content;
	for (const [key, value] of Object.entries(vars)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

/**
 * Parse shell-style quoted arguments: `"hello world" second` → ['hello world', 'second']
 */
function parseShellArgs(argsStr: string): string[] {
	const args: string[] = [];
	let current = '';
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < argsStr.length; i++) {
		const ch = argsStr[i];
		if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
		if (ch === ' ' && !inSingle && !inDouble) {
			if (current) { args.push(current); current = ''; }
			continue;
		}
		current += ch;
	}
	if (current) args.push(current);
	return args;
}

/**
 * Replace $ARGUMENTS, $ARGUMENTS[N], $0, $1, etc. with actual argument values.
 */
function fillArgumentVariables(content: string, userArgs: string): string {
	let result = content;
	const parsedArgs = parseShellArgs(userArgs);

	// $ARGUMENTS[N] and $N — indexed access (must be replaced before $ARGUMENTS)
	result = result.replace(/\$ARGUMENTS\[(\d+)]/g, (_, n) => parsedArgs[parseInt(n, 10)] ?? '');
	result = result.replace(/\$(\d+)\b/g, (_, n) => parsedArgs[parseInt(n, 10)] ?? '');

	// $ARGUMENTS — full argument string
	result = result.replaceAll('$ARGUMENTS', userArgs);

	return result;
}

/**
 * Execute inline shell commands: !`command` → command output.
 * Also handles fenced ```! blocks for multi-line commands.
 * Runs in the skill's working directory with a short timeout.
 */
function executeInlineShellCommands(content: string, workingDir: string): string {
	// Fenced ```! blocks — multi-line shell execution
	let result = content.replace(/```!\n([\s\S]*?)```/g, (_, block: string) => {
		const cmd = block.trim();
		try {
			return execSync(cmd, { cwd: workingDir, timeout: 10_000, encoding: 'utf-8' }).trim();
		} catch {
			return `[shell command failed: ${cmd.split('\n')[0]}]`;
		}
	});

	// Inline !`command` syntax
	result = result.replace(/!`([^`]+)`/g, (_, cmd: string) => {
		try {
			return execSync(cmd.trim(), { cwd: workingDir, timeout: 10_000, encoding: 'utf-8' }).trim();
		} catch {
			return `[shell command failed: ${cmd.trim()}]`;
		}
	});

	return result;
}

export interface ResolvedSkill {
	/** The resolved prompt to send to the headless runner */
	prompt: string;
	/** The original skill name */
	skillName: string;
	/** Any user arguments after the skill name */
	userArgs: string;
}

/**
 * Resolve a slash command (e.g. "/code-review src/") into the skill's prompt content.
 * Returns null if the prompt is not a slash command or the skill is not found.
 *
 * Implements the Claude Code skill spec:
 * - Strips YAML frontmatter, extracts body as the prompt
 * - Fills {{mustache}} template variables (dirPath, cliFindingsSection)
 * - Substitutes $ARGUMENTS, $ARGUMENTS[N], $0/$1 with user-provided arguments
 * - Executes inline shell commands (!`cmd` and ```! blocks)
 * - Replaces ${CLAUDE_SKILL_DIR} with the skill's directory path
 * - Appends user args as "ARGUMENTS: ..." if $ARGUMENTS is not used in the content
 */
function parseSlashCommand(trimmed: string): { skillName: string; userArgs: string } | null {
	if (!trimmed.startsWith('/')) return null;
	const spaceIdx = trimmed.indexOf(' ');
	const skillName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
	const userArgs = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
	return skillName ? { skillName, userArgs } : null;
}

const CLAUDE_SKILL_DIR_RE = /\$\{CLAUDE_SKILL_DIR}/g;
const CLAUDE_SESSION_ID_RE = /\$\{CLAUDE_SESSION_ID}/g;

function processSkillContent(rawContent: string, userArgs: string, skillDir: string, workingDir: string): string {
	let content = extractSkillContent(rawContent);

	content = fillTemplateVariables(content, {
		dirPath: userArgs || workingDir,
		cliFindingsSection: '',
	});

	const hasArgumentsPlaceholder = /\$ARGUMENTS|\$\d+\b/.test(content);
	if (hasArgumentsPlaceholder) {
		content = fillArgumentVariables(content, userArgs);
	}

	content = content.replace(CLAUDE_SKILL_DIR_RE, skillDir);
	content = content.replace(CLAUDE_SESSION_ID_RE, `mstro-${Date.now()}`);

	if (/!`[^`]+`/.test(content) || /```!\n/.test(content)) {
		content = executeInlineShellCommands(content, workingDir);
	}

	if (userArgs && !hasArgumentsPlaceholder && !rawContent.includes('{{dirPath}}')) {
		content = `${content}\n\nARGUMENTS: ${userArgs}`;
	}

	return content;
}

export function resolveSkillPrompt(prompt: string, workingDir: string): ResolvedSkill | null {
	const parsed = parseSlashCommand(prompt.trim());
	if (!parsed) return null;

	const found = findSkillContent(parsed.skillName, workingDir);
	if (!found) return null;

	const fm = parseFrontmatter(found.content);
	if (fm['user-invocable'] === 'false') return null;

	const skillPrompt = processSkillContent(found.content, parsed.userArgs, found.skillDir, workingDir);
	return { prompt: skillPrompt, skillName: parsed.skillName, userArgs: parsed.userArgs };
}
