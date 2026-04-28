export const WORKSPACE_MONO_FONT_FAMILY =
  '"Maple Mono NF", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

export const WORKSPACE_FONT_FEATURE_SETTINGS = "'liga' 1, 'calt' 1"
export const WORKSPACE_FONT_VARIANT_LIGATURES =
  'common-ligatures contextual'
export const WORKSPACE_EDITOR_FONT_LIGATURES = true

const TERMINAL_LIGATURE_SEQUENCES = [
  '<!--',
  '-->',
  '!==',
  '===',
  '==>',
  '<==',
  '<=>',
  '>>>',
  '<<<',
  '>>=',
  '<<=',
  '...',
  '=>',
  '->',
  '<-',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '::',
  '++',
  '--',
  '**',
  '?.',
  '??',
  '</',
  '/>',
  '|>',
  ':=',
  '<<',
  '>>',
]

const TERMINAL_LIGATURE_PATTERN = new RegExp(
  TERMINAL_LIGATURE_SEQUENCES.map(escapeRegExp).join('|'),
  'g',
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findWorkspaceTerminalLigatureRanges(
  text: string,
): [number, number][] {
  return Array.from(text.matchAll(TERMINAL_LIGATURE_PATTERN), function range(
    match,
  ) {
    return [match.index, match.index + match[0].length]
  })
}
