import fs from 'node:fs';
import { SHELL_DONE, START_T3, STOP_T3, VM_PYTHON } from './vm-shell.mjs';

const SOURCE = fs.readFileSync(new URL('./vm_resources.py', import.meta.url), 'utf8');
export const RESOURCE_START = START_T3.replace(
  'export T3CODE_HOME=',
  'export T3CODE_TRACE_MAX_BYTES=262144 T3CODE_TRACE_MAX_FILES=1 T3CODE_TRACE_MIN_LEVEL=Warn T3CODE_HOME=',
).replace('>/dev/shm/t3-serve.log 2>&1', '>/dev/null 2>&1');

export function resourceScript({ clean = false, extra = null } = {}) {
  const action = clean ? 'clean_logs(root)' : extra === null ? '' : `require_space(root, ${extra})`;
  const program = `${SOURCE}\nimport json\nroot = Path('/dev/shm')\n${action}\nprint('T3POC_RAM ' + json.dumps(usage(root)))`;
  const encoded = Buffer.from(program).toString('base64');
  return `${VM_PYTHON} -c "import base64; exec(base64.b64decode('${encoded}'))" && echo T3POC_RAM_OK\necho ${SHELL_DONE}\n`;
}

export function register(api) {
  const shell = api.deps.shell;
  // Apply the policy to every restart path, including backup error recovery.
  api.deps.shell = async (request) => {
    if (Buffer.byteLength(request.script) > 16 * 1024) {
      // Outer transfer script + decoded payload + restored files can coexist.
      const extra = 3 * Buffer.byteLength(request.script);
      const checked = await shell({ script: resourceScript({ extra }) });
      if (!checked.includes('T3POC_RAM_OK')) throw new Error('RAM reserve insufficient for transfer');
    }
    return shell({ ...request, script: request.script.replaceAll(START_T3, RESOURCE_START) });
  };
  let configuredFor;
  let sampledAt = -Infinity;
  const configure = async (runtime) => {
    if (configuredFor === runtime.session.microvmId) return;
    const stopped = await shell({ script: STOP_T3 });
    if (!stopped.includes('T3POC_T3_STOPPED')) throw new Error('T3 resource policy could not stop server');
    runtime.flags.t3Stopped = true;
    const cleaned = await shell({ script: resourceScript({ clean: true }) });
    if (!cleaned.includes('T3POC_RAM_OK')) throw new Error('T3 resource log cleanup failed');
    configuredFor = runtime.session.microvmId;
  };
  api.hooks.prepareDisk.push(configure);
  api.hooks.onVmReady.push(async (runtime) => {
    await configure(runtime);
    if (runtime.flags.t3Stopped) {
      const started = await runtime.deps.shell({ script: START_T3 });
      if (!started.includes('T3POC_T3_STARTED')) throw new Error('T3 resource policy restart failed');
      runtime.flags.t3Stopped = false;
    }
  });
  api.hooks.onTick.push(async (runtime) => {
    if (!runtime.session.microvmId || runtime.session.vmState !== 'RUNNING' || runtime.now() - sampledAt < 60000)
      return;
    sampledAt = runtime.now();
    const out = await shell({ script: resourceScript() });
    const line = out.match(/T3POC_RAM (\{[^\r\n]+\})/);
    if (!line) {
      runtime.log('RAM monitoring failed');
      return;
    }
    const state = JSON.parse(line[1]);
    runtime.log(
      `RAM ${state.warning ? 'WARNING' : 'usage'} used=${state.used} total=${state.total} free=${state.free} worktrees=${state.worktrees}`,
    );
  });
}
