import type { PluginProgram } from '@harnessmate/protocol';

export const pluginTextLimit = 12_000;

export function runPluginProgram(program: PluginProgram, input: string): string {
  if (input.length > pluginTextLimit) throw new Error('插件输入过长');
  let text = input;
  for (const step of program.steps) {
    switch (step.op) {
      case 'trim': text = text.trim(); break;
      case 'case': text = step.mode === 'upper' ? text.toUpperCase() : text.toLowerCase(); break;
      case 'replace': text = text.replaceAll(step.find, () => step.replacement); break;
      case 'wrap': text = `${step.prefix}${text}${step.suffix}`; break;
      case 'lines': {
        let lines = text.split(/\r?\n/);
        if (step.contains !== undefined) {
          const term = step.ignoreCase ? step.contains.toLowerCase() : step.contains;
          lines = lines.filter((line) => (step.ignoreCase ? line.toLowerCase() : line).includes(term));
        }
        if (step.unique) lines = [...new Set(lines)];
        if (step.order) {
          lines.sort();
          if (step.order === 'desc') lines.reverse();
        }
        text = lines.slice(0, step.limit).join('\n');
        break;
      }
    }
    if (text.length > pluginTextLimit) throw new Error('插件输出过长');
  }
  return text;
}
