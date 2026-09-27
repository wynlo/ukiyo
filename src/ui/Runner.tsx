import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useState } from 'react';
import type { Emit, PipelineEvent } from '../pipeline.js';

type Row = { target: string; step: string; state: 'running' | 'done' | 'skip' | 'error' | 'warn' | 'wait'; message?: string; startedAt?: number };

export type RunnerProps = {
  title: string;
  task: (emit: Emit) => Promise<void>;
  onFinish?: (failed: boolean) => void;
};

/**
 * Runs a pipeline task and shows one row per (target, step): a spinner while
 * it runs, then the outcome. Warnings and provider chatter go to a log tail.
 */
export function Runner({ title, task, onFinish }: RunnerProps) {
  const { exit } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [finished, setFinished] = useState<null | { failed: boolean }>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let failed = false;
    const emit: Emit = (event: PipelineEvent) => {
      if (event.type === 'log') {
        setLog((lines) => [...lines.slice(-7), event.message]);
        return;
      }
      const key = (r: Row) => r.target === event.target && r.step === event.step;
      setRows((current) => {
        const next = [...current];
        const index = next.findIndex(key);
        const base: Row = index >= 0 ? next[index]! : { target: event.target, step: event.step, state: 'running' };
        let row: Row;
        switch (event.type) {
          case 'start':
            row = { ...base, state: 'running', message: event.message, startedAt: Date.now() };
            break;
          case 'done':
            row = { ...base, state: 'done', message: event.message };
            break;
          case 'skip':
            row = { ...base, state: 'skip', message: event.message };
            break;
          case 'warn':
            setLog((lines) => [...lines.slice(-7), `warn ${event.target}: ${event.message}`]);
            return current;
          case 'wait':
            row = { ...base, state: 'wait', message: event.message };
            break;
          case 'error':
            failed = true;
            row = { ...base, state: 'error', message: event.message };
            break;
        }
        if (index >= 0) next[index] = row;
        else next.push(row);
        return next;
      });
    };
    task(emit)
      .catch((error: unknown) => {
        failed = true;
        setLog((lines) => [...lines, `error: ${error instanceof Error ? error.message : String(error)}`]);
      })
      .finally(() => {
        setFinished({ failed });
        onFinish?.(failed);
        setTimeout(() => exit(), 50);
      });
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {rows.map((row) => (
        <Box key={`${row.target}:${row.step}`} gap={1}>
          <Box width={2}>
            {row.state === 'running' || row.state === 'wait' ? (
              <Text color="yellow">
                <Spinner type="dots" />
              </Text>
            ) : row.state === 'done' ? (
              <Text color="green">✓</Text>
            ) : row.state === 'skip' ? (
              <Text color="gray">·</Text>
            ) : (
              <Text color="red">✗</Text>
            )}
          </Box>
          <Box width={8}>
            <Text color="cyan">{row.step}</Text>
          </Box>
          <Box width={26}>
            <Text>{row.target}</Text>
          </Box>
          <Text color={row.state === 'error' ? 'red' : row.state === 'skip' ? 'gray' : row.state === 'wait' ? 'yellow' : undefined}>
            {row.message ?? ''}
            {row.state === 'running' && row.startedAt ? ` ${Math.round((Date.now() - row.startedAt) / 1000)}s` : ''}
          </Text>
        </Box>
      ))}
      {log.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {log.map((line, i) => (
            <Text key={i} color="gray" wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      )}
      {finished && (
        <Box marginTop={1}>
          <Text color={finished.failed ? 'red' : 'green'}>{finished.failed ? 'Finished with errors.' : 'Done.'}</Text>
        </Box>
      )}
    </Box>
  );
}
