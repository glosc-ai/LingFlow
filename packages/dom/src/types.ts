import type { TranslationResponse } from '@lingflow/core';

export interface ReadableSegment {
  readonly id: string;
  readonly element: HTMLElement;
  readonly text: string;
}

export interface ExtractReadableSegmentsOptions {
  readonly minTextLength?: number;
  readonly maxSegments?: number;
}

export interface BilingualSegment {
  readonly source: string;
  readonly translation?: TranslationResponse;
}

export type InjectionMode = 'below' | 'replace';

export interface InjectBilingualTextOptions {
  readonly mode?: InjectionMode;
  readonly className?: string;
}

export const LINGFLOW_SEGMENT_ATTRIBUTE = 'data-lingflow-segment-id';
export const LINGFLOW_INJECTED_ATTRIBUTE = 'data-lingflow-injected';
