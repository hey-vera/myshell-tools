import { bold, cyan, dim, yellow } from '../ui/theme.js';

export interface DecisionPromptOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

export interface DecisionPrompt {
  readonly kind: 'timeout' | 'keep-going' | 'checkpoint' | 'question';
  readonly title: string;
  readonly message?: string;
  readonly options: readonly DecisionPromptOption[];
  readonly multiSelect?: boolean;
  readonly allowFreeText?: boolean;
  readonly defaultOptionId?: string;
}

function accent(text: string, kind: DecisionPrompt['kind'], color: boolean): string {
  return (kind === 'timeout' || kind === 'checkpoint' ? yellow : cyan)(text, color);
}

function linesForMessage(message: string | undefined): string[] {
  if (message === undefined) return [];
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed.split('\n').map((line) => `  ${line}`) : [];
}

function buildOptionSuffix(
  option: DecisionPromptOption,
  isDefault: boolean,
  color: boolean,
): string {
  const tags: string[] = [];
  if (option.recommended) tags.push('recommended');
  if (isDefault) tags.push('Enter');
  return tags.length > 0 ? ` ${dim(`(${tags.join(', ')})`, color)}` : '';
}

function buildHint(prompt: DecisionPrompt): string {
  const defaultIndex = prompt.defaultOptionId === undefined
    ? -1
    : prompt.options.findIndex((opt) => opt.id === prompt.defaultOptionId);

  if (prompt.kind === 'timeout' || prompt.kind === 'keep-going') {
    const enter = defaultIndex >= 0 ? `Enter = ${defaultIndex + 1}` : 'Enter = default';
    return `${enter} · y = yes · n = no · Ctrl+C = cancel`;
  }

  const selection = prompt.multiSelect
    ? 'Type one or more numbers (comma-separated)'
    : 'Type a number';
  const freeText = prompt.allowFreeText ? ' or your own answer' : '';
  const enter = defaultIndex >= 0 ? `Enter = ${defaultIndex + 1}` : 'Enter = skip';
  return `${selection}${freeText} · ${enter} · Ctrl+C = cancel`;
}

export function renderDecisionPrompt(prompt: DecisionPrompt, color: boolean): string {
  const lines: string[] = [];
  const marker = prompt.kind === 'checkpoint' ? '!' : '?';
  const label = prompt.kind === 'keep-going'
    ? 'Keep Going'
    : prompt.kind === 'timeout'
      ? 'Timeout'
      : prompt.kind === 'checkpoint'
        ? 'Checkpoint'
        : 'Question';

  lines.push(`${accent(marker, prompt.kind, color)} ${bold(`${label}: ${prompt.title}`, color)}`);
  lines.push(...linesForMessage(prompt.message));

  for (let i = 0; i < prompt.options.length; i++) {
    const option = prompt.options[i];
    if (option === undefined) continue;
    const isDefault = option.id === prompt.defaultOptionId;
    lines.push(`  ${i + 1}. ${option.label}${buildOptionSuffix(option, isDefault, color)}`);
    if (option.description !== undefined && option.description.trim().length > 0) {
      lines.push(`     ${dim(option.description.trim(), color)}`);
    }
  }

  lines.push(`  ${dim(buildHint(prompt), color)}`);
  return lines.join('\n') + '\n';
}
