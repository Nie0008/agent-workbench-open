import * as os from 'node:os';
import * as path from 'node:path';

export function workbenchDataDir(env = process.env, platform = process.platform) {
  if (env.WORKBENCH_DATA_DIR) return path.resolve(env.WORKBENCH_DATA_DIR);
  const home = os.homedir();
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'Agent Workbench');
}
