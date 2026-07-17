import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    isPdfFile,
    isSafeWebImage,
    isSpreadsheetFile,
    removeFileQuietly,
} from '../lib/fileValidation';

describe('uploaded file signatures', () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'eduvault-upload-'));
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it('accepts known PDF and web image signatures', async () => {
        const pdf = path.join(directory, 'material.pdf');
        const png = path.join(directory, 'image.png');
        await writeFile(pdf, Buffer.from('%PDF-1.7\n'));
        await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));

        expect(await isPdfFile(pdf)).toBe(true);
        expect(await isSafeWebImage(png)).toBe(true);
    });

    it('rejects content whose extension does not match its signature', async () => {
        const disguised = path.join(directory, 'malware.pdf');
        await writeFile(disguised, Buffer.from('<script>alert(1)</script>'));

        expect(await isPdfFile(disguised)).toBe(false);
        expect(await isSafeWebImage(disguised)).toBe(false);
        expect(await isSpreadsheetFile(disguised)).toBe(false);
    });

    it('recognizes XLSX ZIP signatures and removes temporary files idempotently', async () => {
        const spreadsheet = path.join(directory, 'students.xlsx');
        await writeFile(spreadsheet, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));

        expect(await isSpreadsheetFile(spreadsheet)).toBe(true);
        await removeFileQuietly(spreadsheet);
        await removeFileQuietly(spreadsheet);
        await expect(readFile(spreadsheet)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
