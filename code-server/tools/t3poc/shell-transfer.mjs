import { createHash, randomBytes } from 'node:crypto';
export const TRANSFER_CHUNK_BYTES = 12 * 1024;
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
// Allow a bounded one-second round trip per acknowledged chunk, in addition
// to the caller's execution budget. The 64 MiB limit bounds the total budget.
export function transferBudgetMs(script, stdin) {
  const bytes = Buffer.byteLength(JSON.stringify({ script, stdin: stdin ? `${stdin}\n` : null }));
  if (bytes > MAX_TRANSFER_BYTES) throw new Error('MicroVM script exceeds transfer limit');
  return (Math.ceil(bytes / TRANSFER_CHUNK_BYTES) + 5) * 1000;
}
// Public receiver code only. Secret-bearing scripts arrive later, after raw-mode
// readiness, and are staged only in a fresh 0700 /dev/shm directory.
export function receiverSource(nonce) {
  return `import sys,os,json,base64,hashlib,tempfile,subprocess,termios,tty
fd=sys.stdin.fileno()
old=globals().get("ORIGINAL_TTY") or termios.tcgetattr(fd)
tag="T3POC_RX_${nonce}_"
def emit(text):
 sys.stdout.write("\\r\\n"+tag+text+"\\r\\n");sys.stdout.flush()
try:
 tty.setraw(fd)
 emit("READY")
 header=json.loads(sys.stdin.buffer.readline(4096))
 size=header["size"];expected=header["sha256"]
 if type(size) is not int or size<0 or size>${MAX_TRANSFER_BYTES}: raise ValueError()
 if not isinstance(expected,str) or len(expected)!=64: raise ValueError()
 data=bytearray();count=0
 emit("ACK_0")
 while True:
  line=sys.stdin.buffer.readline(16386)
  if line==b".\\n":break
  if not line.endswith(b"\\n") or len(line)>16385:raise ValueError()
  block=base64.b64decode(line.strip(),validate=True)
  if len(block)>${TRANSFER_CHUNK_BYTES} or len(data)+len(block)>size:raise ValueError()
  data.extend(block);count+=1;emit("ACK_"+str(count))
 if len(data)!=size or hashlib.sha256(data).hexdigest()!=expected:raise ValueError()
 payload=json.loads(data)
 if not isinstance(payload.get("script"),str) or (payload.get("stdin") is not None and not isinstance(payload["stdin"],str)):raise ValueError()
 emit("VERIFIED")
 with tempfile.TemporaryDirectory(prefix="t3poc-transfer-",dir="/dev/shm") as folder:
  file=os.path.join(folder,"script.sh")
  with open(file,"x",opener=lambda p,f:os.open(p,f,0o600)) as output:output.write(payload["script"]+"\\n")
  result=subprocess.run(["/bin/bash",file],input=(payload.get("stdin") or "").encode())
 emit("FINISHED_"+str(result.returncode))
except BaseException:
 emit("ABORT")
finally:
 termios.tcsetattr(fd,termios.TCSANOW,old)
`;
}

export async function transferScript({ script, stdin, python, waitFor, send }) {
  const nonce = randomBytes(12).toString('hex');
  const prefix = `T3POC_RX_${nonce}_`;
  const expect = async (suffix) => waitFor(new RegExp(`(?:^|[\\r\\n])${prefix}${suffix}(?:\\r?\\n|$)`), prefix);
  const payload = Buffer.from(JSON.stringify({ script, stdin: stdin ? `${stdin}\n` : null }));
  if (payload.length > MAX_TRANSFER_BYTES) throw new Error('MicroVM script exceeds transfer limit');
  // Keep the initial command below the smallest PTY canonical-line limit.
  // Only send the larger public receiver after raw-mode readiness is confirmed.
  const boot = `import sys,tty,termios,base64;fd=sys.stdin.fileno();old=termios.tcgetattr(fd);tty.setraw(fd);print("\\r\\n${prefix}SOURCE\\r\\n",flush=True);exec(base64.b64decode(sys.stdin.buffer.readline(16384)),{"ORIGINAL_TTY":old})`;
  await send(`${python} -c '${boot}'\n`);
  await expect('SOURCE');
  await send(`${Buffer.from(receiverSource(nonce)).toString('base64')}\n`);
  await expect('READY');
  await send(
    `${JSON.stringify({ size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') })}\n`,
  );
  await expect('ACK_0');
  let count = 0;
  for (let at = 0; at < payload.length; at += TRANSFER_CHUNK_BYTES) {
    await send(`${payload.subarray(at, at + TRANSFER_CHUNK_BYTES).toString('base64')}\n`);
    await expect(`ACK_${++count}`);
  }
  await send('.\n');
  await expect('VERIFIED');
  await expect('FINISHED_-?[0-9]+');
}
