import { Box, Text, useApp, useInput } from 'ink';
import open from 'open';
import path from 'node:path';
import { useState } from 'react';
import type { ResolvedConfig } from '../config.js';
import type { Manifest } from '../manifest.js';
import type { TargetStatus } from '../meta.js';
import { composePrompt } from '../prompt/compose.js';
import { createPipeline, type Emit, type Pipeline } from '../pipeline.js';
import { Runner } from './Runner.js';
import { StatusTable } from './StatusTable.js';

type Mode = { kind: 'idle' } | { kind: 'run'; title: string; task: (emit: Emit) => Promise<void> } | { kind: 'prompt'; text: string };

export function Dashboard({ config, manifest }: { config: ResolvedConfig; manifest: Manifest }) {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [rows, setRows] = useState<TargetStatus[]>(() => createPipeline(config, manifest, () => {}).status());
  const [message, setMessage] = useState('');

  const refresh = () => setRows(createPipeline(config, manifest, () => {}).status());
  const run = (title: string, fn: (p: Pipeline) => Promise<unknown>) => {
    setMode({
      kind: 'run',
      title,
      task: async (emit) => {
        await fn(createPipeline(config, manifest, emit));
      },
    });
  };

  useInput((input, key) => {
    if (mode.kind === 'prompt') {
      setMode({ kind: 'idle' });
      return;
    }
    if (mode.kind !== 'idle') return;
    const target = manifest[selected];
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSelected((s) => Math.min(manifest.length - 1, s + 1));
    else if (key.return && target) run(`run missing steps: ${target.target}`, (p) => p.all([target.target]));
    else if (input === 'a') run('run everything', (p) => p.all());
    else if (input === 'g' && target) run(`gen ${target.target}`, (p) => p.gen([target.target]));
    else if (input === 'c' && target) run(`cut ${target.target}`, (p) => p.cut([target.target], true).then(() => p.finalize([target.target], true)));
    else if (input === 'r' && target) run(`redo ${target.target}`, async (p) => p.redo(target.target));
    else if (input === 's' && target) {
      run(`sheet ${target.target}`, async (p) => {
        const files = await p.sheet([target.target]);
        if (files[0]) await open(files[0]);
      });
    } else if (input === 'p' && target) setMode({ kind: 'prompt', text: composePrompt(config, target) });
    else if (input === 'k') run('pack approved', (p) => p.pack());
    else if (input === 'q' || key.escape) exit();
  });

  if (mode.kind === 'run') {
    return (
      <Runner
        title={mode.title}
        task={mode.task}
        onFinish={(failed) => {
          refresh();
          setMessage(failed ? 'finished with errors' : 'done');
          setMode({ kind: 'idle' });
        }}
      />
    );
  }
  if (mode.kind === 'prompt') {
    return (
      <Box flexDirection="column">
        <Text>{mode.text}</Text>
        <Text color="gray">press any key to return</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>
        ukiyo · {config.project.name} · {config.styleGuide.name} · {path.relative(process.cwd(), config.outDir) || '.'}
      </Text>
      <Box marginTop={1}>
        <StatusTable rows={rows} selected={selected} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">↑↓ select · enter run missing steps · a all · g gen · c re-cut · r redo · s sheet · p prompt · k pack · q quit</Text>
        {message ? <Text color="yellow">{message}</Text> : null}
      </Box>
    </Box>
  );
}
