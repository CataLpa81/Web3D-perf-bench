export function chromiumArgs() {
  const args = [
    '--ignore-gpu-blocklist',
    '--enable-gpu',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ];
  if (process.platform === 'darwin') args.unshift('--use-angle=metal');
  return args;
}
