import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Validate metadata only. The official Harness owns parsing and token refresh. */
export async function validateCredentialFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('DSH_MCP_CREDENTIALS_FILE must be an absolute path');
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error('not-file');
    if (process.platform !== 'win32' && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)) {
      throw new Error('permissions');
    }
    return canonical;
  } catch {
    throw new Error('DSH_MCP_CREDENTIALS_FILE must be an existing regular file owned by the current user with owner-only permissions (chmod 600)');
  }
}
