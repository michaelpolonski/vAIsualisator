import { gzipSync } from "node:zlib";

function pad(value: string, length: number): Buffer {
  const buf = Buffer.alloc(length, 0);
  const content = Buffer.from(value, "utf8");
  content.copy(buf, 0, 0, Math.min(content.length, length));
  return buf;
}

function formatOctal(value: number, length: number): string {
  // Tar numeric fields are octal, NUL-terminated (often with trailing space).
  const oct = value.toString(8);
  const padded = oct.padStart(length - 1, "0");
  return `${padded}\0`;
}

function tarHeader(args: {
  name: string;
  size: number;
  mtime: number;
  mode?: number;
}): Buffer {
  const header = Buffer.alloc(512, 0);
  const mode = args.mode ?? 0o644;
  const uid = 0;
  const gid = 0;

  pad(args.name, 100).copy(header, 0);
  pad(formatOctal(mode, 8), 8).copy(header, 100);
  pad(formatOctal(uid, 8), 8).copy(header, 108);
  pad(formatOctal(gid, 8), 8).copy(header, 116);
  pad(formatOctal(args.size, 12), 12).copy(header, 124);
  pad(formatOctal(args.mtime, 12), 12).copy(header, 136);

  // checksum field initially filled with spaces
  Buffer.from("        ").copy(header, 148);

  // typeflag: '0' for a regular file
  header[156] = "0".charCodeAt(0);

  // magic + version
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);

  // compute checksum
  let sum = 0;
  for (let i = 0; i < 512; i += 1) {
    sum += header[i] ?? 0;
  }
  const checksum = sum.toString(8).padStart(6, "0");
  Buffer.from(`${checksum}\0 `).copy(header, 148);

  return header;
}

function padTo512(buf: Buffer): Buffer {
  const remainder = buf.length % 512;
  if (remainder === 0) {
    return buf;
  }
  const padded = Buffer.alloc(buf.length + (512 - remainder), 0);
  buf.copy(padded, 0);
  return padded;
}

export function createTarGz(files: Array<{ path: string; content: string }>): Buffer {
  const chunks: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);

  for (const file of files) {
    const normalizedPath = file.path.replaceAll("\\\\", "/").replace(/^\/+/, "");
    const contentBuf = Buffer.from(file.content, "utf8");
    chunks.push(
      tarHeader({
        name: normalizedPath,
        size: contentBuf.length,
        mtime,
      }),
    );
    chunks.push(padTo512(contentBuf));
  }

  // End of archive: two 512-byte zero blocks.
  chunks.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(chunks);
  return gzipSync(tar, { level: 9 });
}

