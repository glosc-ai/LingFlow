import type { TranslationResponse } from '@lingflow/core';
import {
  LINGFLOW_INJECTED_ATTRIBUTE,
  LINGFLOW_SEGMENT_ATTRIBUTE,
  type InjectBilingualTextOptions,
  type ReadableSegment,
} from '../types.js';

export function injectBilingualText(
  segment: ReadableSegment,
  translation: TranslationResponse,
  options: InjectBilingualTextOptions = {},
) {
  removeInjectedForSegment(segment);

  if (options.mode === 'replace') {
    segment.element.textContent = translation.text;
    return segment.element;
  }

  const node = document.createElement('div');
  node.setAttribute(LINGFLOW_INJECTED_ATTRIBUTE, 'true');
  node.setAttribute(LINGFLOW_SEGMENT_ATTRIBUTE, segment.id);
  node.className = options.className ?? 'lingflow-bilingual-text';
  node.textContent = translation.text;
  applyDefaultStyle(node);
  segment.element.insertAdjacentElement('afterend', node);
  return node;
}

export function cleanupLingFlow(root: ParentNode = document.body) {
  const nodes = root.querySelectorAll(`[${LINGFLOW_INJECTED_ATTRIBUTE}]`);
  nodes.forEach((node) => node.remove());
}

function removeInjectedForSegment(segment: ReadableSegment) {
  const selector = `[${LINGFLOW_INJECTED_ATTRIBUTE}][${LINGFLOW_SEGMENT_ATTRIBUTE}="${segment.id}"]`;
  segment.element.parentElement?.querySelectorAll(selector).forEach((node) => node.remove());
}

function applyDefaultStyle(node: HTMLElement) {
  node.style.margin = '0.35em 0 0.85em';
  node.style.padding = '0.55em 0.75em';
  node.style.borderLeft = '3px solid #2f7d68';
  node.style.background = 'rgba(47, 125, 104, 0.08)';
  node.style.color = '#35524a';
  node.style.fontSize = '0.92em';
  node.style.lineHeight = '1.65';
}
