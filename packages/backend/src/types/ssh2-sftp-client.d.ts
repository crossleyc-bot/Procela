// ssh2-sftp-client ships no type declarations. The SFTP object-store adapter
// (lib/object-storage/sftp.ts) uses it through a loose `any` client, so a
// minimal ambient module declaration is enough to satisfy the compiler.
declare module 'ssh2-sftp-client' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SftpClient: any;
  export default SftpClient;
}
