import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import type * as vscode from 'vscode';
import { getAgentTools, invokeAgentTool, toolResultsToMessages, verifyResearchSources, type AgentToolOptions } from '../../src/agent-tools';
import { RESEARCH_TOOLS, type ResearchPolicy } from '../../src/subagent-types';

const env = vi.hoisted(() => ({
  folders: [] as vscode.WorkspaceFolder[], files: [] as vscode.Uri[],
  diagnostics: [] as [vscode.Uri, vscode.Diagnostic[]][],
  read: vi.fn(), find: vi.fn(), approve: vi.fn(), effect: vi.fn(), cancel: vi.fn(),
}));

vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file', authority: '', toString: () => fsPath });
  return {
    Uri: { joinPath: (base: { fsPath: string }, relative: string) => uri(path.resolve(base.fsPath, relative)) },
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    CancellationTokenSource: class { token = {}; cancel = env.cancel; dispose() {} },
    workspace: {
      get workspaceFolders() { return env.folders; },
      findFiles: env.find,
      fs: { readFile: env.read, writeFile: env.effect, delete: env.effect },
      openTextDocument: env.effect, applyEdit: env.effect,
    },
    languages: { getDiagnostics: (target?: vscode.Uri) => target ? env.diagnostics.find(([uri]) => uri.fsPath === target.fsPath)?.[1] ?? [] : env.diagnostics },
    window: { showTextDocument: env.effect, showWarningMessage: env.effect },
    commands: { executeCommand: env.effect }, DiagnosticSeverity: { 0: 'Error' },
  };
});

let root: string;
let policy: ResearchPolicy;
function uri(relative: string): vscode.Uri {
  return { fsPath: path.resolve(root, relative), scheme: 'file', authority: '' } as vscode.Uri;
}
function invoke(name: string, args: Record<string, unknown> = {}, options: AgentToolOptions = {}) {
  return invokeAgentTool('test', name, JSON.stringify(args), { researchPolicy: policy, approvalMode: 'full', approve: env.approve, ...options });
}

beforeEach(async () => {
  vi.resetAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'deeplocal-research-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'src-other'));
  await fs.writeFile(path.join(root, 'src/a.txt'), 'needle allowed');
  await fs.writeFile(path.join(root, 'src/b.txt'), 'needle second');
  await fs.writeFile(path.join(root, 'src-other/secret.txt'), 'needle secret');
  env.folders = [{ name: 'test', index: 0, uri: uri('.') }];
  env.files = [uri('src/a.txt'), uri('src-other/secret.txt'), uri('src/b.txt')];
  env.diagnostics = env.files.map(target => [target, [{ severity: 0, message: target.fsPath.includes('secret') ? 'secret diagnostic' : 'allowed diagnostic', range: { start: { line: 0, character: 0 } } } as vscode.Diagnostic]]);
  env.read.mockImplementation((target: vscode.Uri) => fs.readFile(target.fsPath));
  env.find.mockImplementation(async () => env.files);
  env.approve.mockResolvedValue(true);
  policy = { tools: RESEARCH_TOOLS, paths: ['src'] };
});

afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it.each(['full', 'safe', 'every', 'ask'] as const)('denies forbidden direct tool calls before approval/effects in %s mode', async approvalMode => {
  for (const name of ['write_file', 'create_file', 'replace_in_file', 'delete_file', 'run_command', 'get_selection', 'get_active_file', 'get_workspace_summary', 'open_file', 'discover_verification_commands', 'invented']) {
    expect(await invoke(name, { path: 'src/a.txt', command: 'node', args: [] }, { approvalMode })).toMatchObject({ status: 'error', content: expect.stringContaining('Research policy does not permit') });
  }
  expect(env.approve).not.toHaveBeenCalled();
  expect(env.effect).not.toHaveBeenCalled();
  expect(env.read).not.toHaveBeenCalled();
});

it('advertises only the policy intersection and enforces omitted read tools', async () => {
  policy = { tools: ['read_file'], paths: ['src/a.txt'] };
  expect(getAgentTools(policy).map(tool => tool.function.name)).toEqual(['read_file']);
  expect(await invoke('search_workspace', { query: 'needle' })).toMatchObject({ status: 'error' });
  expect(await invoke('read_file', { path: 'src/b.txt' })).toMatchObject({ status: 'error' });
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'success', content: 'needle allowed' });
});

it.each(['src-other/secret.txt', '../secret', 'src/../src/a.txt', 'src\\..\\src/a.txt', '/outside', 'C:\\outside', 'file:///outside'])('rejects path %s without reading it', async target => {
  expect(await invoke('read_file', { path: target })).toMatchObject({ status: 'error' });
  expect(env.read).not.toHaveBeenCalled();
});

it('filters discovery, search reads, and diagnostics to segment-bounded scope', async () => {
  expect((await invoke('list_workspace_files')).content).toBe('src/a.txt\nsrc/b.txt');
  expect((await invoke('search_workspace', { query: 'needle' })).content).toBe('src/a.txt:1: needle allowed\nsrc/b.txt:1: needle second');
  expect(env.read.mock.calls.map(([target]) => target.fsPath)).toEqual([uri('src/a.txt').fsPath, uri('src/b.txt').fsPath]);
  const diagnostics = await invoke('get_diagnostics');
  expect(diagnostics.content).toContain('allowed diagnostic');
  expect(diagnostics.content).not.toContain('secret');
  expect(await invoke('get_diagnostics', { path: 'src-other/secret.txt' })).toMatchObject({ status: 'error' });
  expect(env.find.mock.calls[0][1]).toBe('**/{node_modules,.git,dist,out}/**');
});

it('discloses capped discovery before scope filtering without claiming universal absence', async () => {
  env.find.mockImplementation(async (_pattern, _exclude, limit: number) =>
    Array.from({ length: limit }, () => uri('src-other/secret.txt')));
  const list = await invoke('list_workspace_files', { maxResults: 1 });
  const listWarning = 'Discovery inspected only the first 1 workspace candidates; scoped files may be unscanned.';
  expect(list.content).toBe(`${listWarning}\n(no files among inspected candidates)`);
  expect(list.researchLimitations).toEqual([listWarning]);
  const search = await invoke('search_workspace', { query: 'needle' });
  const searchWarning = 'Discovery inspected only the first 500 workspace candidates; scoped files may be unscanned.';
  expect(search.content).toBe(`${searchWarning}\n(no matches among inspected candidates)`);
  expect(search.researchLimitations).toEqual([searchWarning]);
  expect(search.researchSources).toEqual([]);
  expect(env.read).not.toHaveBeenCalled();
  expect(JSON.stringify(toolResultsToMessages([list, search]))).not.toContain('researchLimitations');
});

it('keeps uncapped empty discovery unchanged and reports coverage limits with positive results', async () => {
  env.find.mockResolvedValue([]);
  const emptyList = await invoke('list_workspace_files');
  const emptySearch = await invoke('search_workspace', { query: 'needle' });
  expect(emptyList.content).toBe('(no files)');
  expect(emptySearch.content).toBe('(no matches)');
  expect(emptyList.researchLimitations).toBeUndefined();
  expect(emptySearch.researchLimitations).toBeUndefined();
  env.find.mockResolvedValue([uri('src/a.txt')]);
  const list = await invoke('list_workspace_files', { maxResults: 1 });
  expect(list.content).toMatch(/^Discovery inspected only the first 1 workspace candidates; scoped files may be unscanned\.\nsrc\/a\.txt$/);
  expect(list.researchLimitations).toHaveLength(1);
});

it('rejects linked directories even when the link target is in the workspace', async () => {
  await fs.symlink(path.join(root, 'src-other'), path.join(root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const target = uri('src/linked/secret.txt');
  env.files = [target];
  expect(await invoke('read_file', { path: 'src/linked/secret.txt' })).toMatchObject({ status: 'error', content: expect.stringContaining('symbolic links') });
  expect((await invoke('list_workspace_files')).content).toBe('(no files)');
  expect((await invoke('search_workspace', { query: 'needle' })).content).toBe('(no matches)');
  expect(env.read).not.toHaveBeenCalled();
});

it('rejects a link escaping the pinned root and a file from a different root', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'deeplocal-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret');
    await fs.symlink(outside, path.join(root, 'src/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    env.files = [uri('src/escape/secret.txt'), { ...uri('src/a.txt'), fsPath: path.join(outside, 'secret.txt') } as vscode.Uri];
    expect(await invoke('read_file', { path: 'src/escape/secret.txt' })).toMatchObject({ status: 'error' });
    expect((await invoke('search_workspace', { query: 'secret' })).content).toBe('(no matches)');
    expect(env.read).not.toHaveBeenCalled();
  } finally {
    await fs.rm(path.join(root, 'src/escape'), { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

it.each(['../', 'src/../src', '/absolute', 'C:\\absolute'])('rejects invalid policy scope %s', async scope => {
  policy = { tools: RESEARCH_TOOLS, paths: [scope] };
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error' });
  expect(await invoke('list_workspace_files')).toMatchObject({ status: 'error' });
  expect(env.read).not.toHaveBeenCalled();
});

it('fails closed for non-file roots and cross-root discovery', async () => {
  env.files = [{ ...uri('src/a.txt'), scheme: 'remote' } as vscode.Uri];
  expect((await invoke('list_workspace_files')).content).toBe('(no files)');
  env.folders = [{ ...env.folders[0], uri: { ...env.folders[0].uri, scheme: 'remote' } as vscode.Uri }];
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error' });
  expect(env.read).not.toHaveBeenCalled();
});

it('honors cancellation before discovery and after the first search read', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await invoke('search_workspace', { query: 'needle' }, { signal: controller.signal })).toMatchObject({ status: 'error' });
  expect(env.find).not.toHaveBeenCalled();
  const running = new AbortController();
  env.read.mockImplementation(async (target: vscode.Uri) => { const bytes = await fs.readFile(target.fsPath); running.abort(); return bytes; });
  expect(await invoke('search_workspace', { query: 'needle' }, { signal: running.signal })).toMatchObject({ status: 'error' });
  expect(env.read).toHaveBeenCalledTimes(1);
});

it('passes a cancellation token to discovery and aborts before reading', async () => {
  const controller = new AbortController();
  env.find.mockImplementation(async () => { controller.abort(); return env.files; });
  expect(await invoke('search_workspace', { query: 'needle' }, { signal: controller.signal })).toMatchObject({ status: 'error' });
  expect(env.find.mock.calls[0][3]).toBeDefined();
  expect(env.cancel).toHaveBeenCalledOnce();
  expect(env.read).not.toHaveBeenCalled();
});

it('keeps UTF-8 validation and character limits for restricted reads', async () => {
  expect((await invoke('read_file', { path: 'src/a.txt', maxChars: 6 })).content).toBe('needle\n\n... truncated ...');
  await fs.writeFile(path.join(root, 'src/a.txt'), Buffer.from([0xff]));
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error', content: expect.stringContaining('UTF-8') });
});

it('retains unrestricted tool discovery and read behavior', async () => {
  expect(getAgentTools().some(tool => tool.function.name === 'run_command')).toBe(true);
  expect(await invokeAgentTool('test', 'read_file', JSON.stringify({ path: 'src-other/secret.txt' }), { approvalMode: 'full' })).toMatchObject({ status: 'success', content: 'needle secret' });
});

it('fingerprints the original accessed bytes and verifies unchanged evidence without approvals', async () => {
  const result = await invoke('read_file', { path: 'src/a.txt', maxChars: 6 });
  expect(result.researchSources).toEqual([{ path: 'src/a.txt', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(JSON.stringify(toolResultsToMessages([result]))).not.toContain('digest');
  await verifyResearchSources(result.researchSources!, { researchPolicy: policy });
  expect(env.approve).not.toHaveBeenCalled();
  await fs.writeFile(path.join(root, 'src/a.txt'), 'needle changed beyond the returned prefix');
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
});

it('fingerprints only actually read search sources, including reads without matches', async () => {
  const result = await invoke('search_workspace', { query: 'missing' });
  expect(result.researchSources?.map(source => source.path)).toEqual(['src/a.txt', 'src/b.txt']);
  await verifyResearchSources(result.researchSources!, { researchPolicy: policy });
  await fs.rm(path.join(root, 'src/b.txt'));
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
});

it('rejects out-of-scope and excessive verification metadata without reading files', async () => {
  await expect(verifyResearchSources([{ path: 'src-other/secret.txt', digest: 'any' }], { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
  await expect(verifyResearchSources(Array.from({ length: 501 }, () => ({ path: 'src/a.txt', digest: 'any' })), { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
  expect(env.read).not.toHaveBeenCalled();
});

it('stops evidence verification before reads and between source reads on cancellation', async () => {
  const result = await invoke('search_workspace', { query: 'needle' });
  env.read.mockClear();
  const pre = new AbortController();
  pre.abort();
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy, signal: pre.signal })).rejects.toThrow();
  expect(env.read).not.toHaveBeenCalled();
  const running = new AbortController();
  env.read.mockImplementation(async (target: vscode.Uri) => { const bytes = await fs.readFile(target.fsPath); running.abort(); return bytes; });
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy, signal: running.signal })).rejects.toThrow();
  expect(env.read).toHaveBeenCalledTimes(1);
});
