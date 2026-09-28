/** Display the registered working directory name; keep project IDs stable. */
export function projectName(project?: {rootPath?: string; name?: string}): string {
  const path = project?.rootPath?.replace(/\\/g, '/').replace(/\/+$/, '');
  return path?.split('/').pop() || project?.name || '未识别项目';
}
