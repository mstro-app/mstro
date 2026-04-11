// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSkillsDir } from '../../utils/paths.js';
import type { HandlerContext } from './handler-context.js';
import type { SkillEntry, WSContext } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_AGENTS_DIR = join(__dirname, '..', 'plan', 'agents');

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
	const skills: SkillEntry[] = [];

	const projectSkillsDir = findSkillsDir(workingDir);
	if (projectSkillsDir) {
		skills.push(...scanProjectSkills(projectSkillsDir));
	}

	const seen = new Set(skills.map(s => s.name));
	skills.push(...scanSystemAgents(SYSTEM_AGENTS_DIR, seen));

	skills.sort((a, b) => a.name.localeCompare(b.name));
	ctx.send(ws, { type: 'skillsList', data: { skills } });
}
