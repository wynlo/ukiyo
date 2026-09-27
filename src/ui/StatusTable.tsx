import { Box, Text } from 'ink';
import type { StepState, TargetStatus } from '../meta.js';

function mark(state: StepState): { glyph: string; color: string } {
  switch (state) {
    case 'done':
      return { glyph: '●', color: 'green' };
    case 'partial':
      return { glyph: '◐', color: 'yellow' };
    case 'missing':
      return { glyph: '○', color: 'gray' };
  }
}

export function StatusTable({ rows, selected }: { rows: TargetStatus[]; selected?: number }) {
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Box width={2} flexShrink={0} />
        <Box width={26} flexShrink={0}>
          <Text bold>target</Text>
        </Box>
        <Box width={4} flexShrink={0}>
          <Text bold>raw</Text>
        </Box>
        <Box width={4} flexShrink={0}>
          <Text bold>cut</Text>
        </Box>
        <Box width={6} flexShrink={0}>
          <Text bold>final</Text>
        </Box>
        <Box width={7} flexShrink={0}>
          <Text bold>packed</Text>
        </Box>
        <Box width={14} flexShrink={0}>
          <Text bold>review</Text>
        </Box>
        <Text bold>warnings</Text>
      </Box>
      {rows.map((row, index) => {
        const raw = mark(row.raw);
        const cut = mark(row.cut);
        const fin = mark(row.final);
        const packed = mark(row.packed);
        const r = row.review;
        return (
          <Box key={row.target} gap={1}>
            <Box width={2} flexShrink={0}>
              <Text color="cyan">{selected === index ? '›' : ' '}</Text>
            </Box>
            <Box width={26} flexShrink={0}>
              <Text inverse={selected === index}>{row.target}</Text>
            </Box>
            <Box width={4} flexShrink={0}>
              <Text color={raw.color}>{raw.glyph}</Text>
            </Box>
            <Box width={4} flexShrink={0}>
              <Text color={cut.color}>{cut.glyph}</Text>
            </Box>
            <Box width={6} flexShrink={0}>
              <Text color={fin.color}>{fin.glyph}</Text>
            </Box>
            <Box width={7} flexShrink={0}>
              <Text color={packed.color}>{packed.glyph}</Text>
            </Box>
            <Box width={14} flexShrink={0}>
              <Text>
                <Text color="green">{r.approved}</Text>/<Text color="red">{r.rejected}</Text>/<Text color="yellow">{r.pending}</Text> of {r.total}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color="red" wrap="truncate-end">
                {row.warnings.join(' ')}
              </Text>
            </Box>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="gray">review = approved/rejected/pending · ● done ◐ partial ○ missing</Text>
      </Box>
    </Box>
  );
}
