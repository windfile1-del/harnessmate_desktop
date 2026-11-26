import { z } from 'zod';

export const FILE_PREVIEW_FEATURE = 'ui.filePreview.v1';
export const FILE_PREVIEW_PERMISSION = 'file:preview';

export const FilePreviewContributionSchema = z.object({
  extensions: z.array(
    z.union([
      z.literal('*'),
      z.string().regex(/^\.[a-z0-9][a-z0-9_-]{0,15}$/),
    ]),
  ).min(1).max(24).refine((values) => new Set(values).size === values.length),
  viewerKind: z.enum(['text', 'markdown', 'custom']).optional(),
}).strict();

export interface FilePreviewProviderMeta {
  extensions: string[];
  viewerKind?: 'text' | 'markdown' | 'custom';
  title?: string;
}

export interface FilePreviewRequest {
  readonly version: 1;
  readonly relativePath: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly sizeBytes: number;
  readonly line?: number;
}

export const FilePreviewResultSchema = z.object({
  version: z.literal(1),
  format: z.enum(['markdown', 'text']),
  content: z.string().max(256 * 1024),
  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

/** The optional line refers to the returned content. Return null to use the built-in preview. */
export type FilePreviewResult = z.infer<typeof FilePreviewResultSchema>;
export type FilePreviewRenderer = (request: FilePreviewRequest) => FilePreviewResult | null | Promise<FilePreviewResult | null>;
