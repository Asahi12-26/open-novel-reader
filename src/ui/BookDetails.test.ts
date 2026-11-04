import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Book } from '../types';
const cloud = vi.hoisted(() => ({ setBookCloud: vi.fn() }));
vi.mock('../services/cloud', () => cloud);
vi.mock('./common', () => ({
  BookCover: () => null, Modal: ({ children }: { children: ReactNode }) => children,
  useQuery: () => [], notify: vi.fn(), run: async (action: () => Promise<unknown>) => { await action(); },
}));
import BookDetails from './BookDetails';

it('keeps the requested upload consent after React restores a controlled checkbox during the account check', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let complete!: () => void;
  cloud.setBookCloud.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const book: Book = { id: 'consent-book', title: '本机故事', author: '', language: 'zh', format: 'txt', coverColor: '#355e56', fingerprint: 'a'.repeat(64), chapterCount: 1, totalWords: 20, createdAt: 1, updatedAt: 1, cloudEnabled: false };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BookDetails, { book, onClose: vi.fn(), onRead: vi.fn() })));
    const checkbox = container.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    await act(async () => checkbox.click());
    expect(cloud.setBookCloud).toHaveBeenCalledExactlyOnceWith(book.id, true);
    await act(async () => complete());
    expect(checkbox.checked).toBe(true);
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
