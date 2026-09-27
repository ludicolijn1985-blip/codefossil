import type { AiAnswer, AiConfig } from '@codefossil/ai';
import { isCloud } from '@codefossil/ai';

export function formatAiConfig(config: AiConfig | null): string {
  if (!config) {
    return (
      'The AI layer is off. Every answer comes from the deterministic evidence pipeline.\n' +
      'Turn it on with `codefossil ai configure --provider ollama` (local) or\n' +
      '`codefossil ai configure --provider anthropic --allow-cloud` (evidence leaves this machine).\n'
    );
  }
  const cloud = isCloud(config);
  return [
    `Provider      ${config.provider}${config.baseUrl ? ` (${config.baseUrl})` : ''}`,
    `Model         ${config.model}`,
    `Leaves host   ${cloud ? 'yes — evidence is sent to the provider (you allowed this)' : 'no — the model runs on this machine'}`,
    `Source code   ${config.includeSource ? 'symbol signatures may be sent' : 'withheld (commit, issue and PR text and paths only)'}`,
    '',
  ].join('\n');
}

export function formatAiAnswer(answer: AiAnswer): string {
  const where = answer.cloud ? 'cloud' : 'local';
  const lines = [
    `AI answer (${answer.provider} ${answer.model}, ${where}) · INFERRED ${answer.confidence.toFixed(2)}`,
    '',
    answer.answer,
    '',
  ];
  if (answer.claims.length > 0) {
    lines.push('Claims');
    for (const claim of answer.claims) {
      lines.push(
        `  INFERRED ${claim.confidence.toFixed(2)}  ${claim.text}  [${claim.evidenceIds.join(', ')}]`,
      );
    }
    lines.push('');
  }
  const cited = answer.evidence.filter((e) => e.cited);
  if (cited.length > 0) {
    lines.push('Cited evidence');
    for (const e of cited) lines.push(`  [${String(e.id)}] ${e.type.padEnd(12)} ${e.locator}`);
    lines.push('');
  }
  lines.push('Caveats', ...answer.caveats.map((c) => `  - ${c}`), '');
  return lines.join('\n');
}
