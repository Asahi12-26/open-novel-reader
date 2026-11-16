import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from 'react';
import { Check, ImagePlus, RotateCcw } from 'lucide-react';
import {
  getAvatarOwner, prepareAvatarImage, resetCharacterAvatar, saveCharacterAvatar,
  type AvatarCrop, type AvatarOwnerGuard, type PreparedAvatarImage,
} from '../core/avatar';
import { notify } from './common';

const initialFrame = { x: .5, y: .5, zoom: 1 };
const limit = (value: number) => Math.min(1, Math.max(0, value));
const errorText = (error: unknown) => error instanceof Error ? error.message : '头像未保存，请重试。';

export default function CharacterAvatarEditor({ bookId, characterId, image }: {
  bookId: string;
  characterId: string;
  image?: Blob;
}) {
  const [source, setSource] = useState<PreparedAvatarImage>();
  const [frame, setFrame] = useState(initialFrame);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<PreparedAvatarImage | undefined>(undefined);
  const live = useRef(false);
  const previousOwner = useRef<Promise<AvatarOwnerGuard | null> | undefined>(undefined);
  const drag = useRef<{ pointer: number; x: number; y: number } | undefined>(undefined);

  useEffect(() => {
    live.current = true;
    previousOwner.current = getAvatarOwner(bookId).catch(() => null);
    return () => {
      live.current = false;
      current.current?.dispose();
      current.current = undefined;
    };
  }, [bookId, characterId]);

  const side = source ? Math.min(source.width, source.height) / frame.zoom : 1;
  const width = source ? Math.max(0, source.width - side) : 0;
  const height = source ? Math.max(0, source.height - side) : 0;
  const crop: AvatarCrop = { x: frame.x * width, y: frame.y * height, size: side };

  function replace(next?: PreparedAvatarImage) {
    current.current?.dispose();
    current.current = next;
    drag.current = undefined;
    setSource(next);
    setFrame(initialFrame);
  }

  async function prepare(blob: Blob) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const next = await prepareAvatarImage(blob);
      if (live.current) replace(next);
      else next.dispose();
    } catch (failure) {
      if (live.current) setError(errorText(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void prepare(file);
  }

  async function commit(reset: boolean) {
    if (busy || (!reset && !source)) return;
    setError('');
    setBusy(true);
    try {
      const owner = await previousOwner.current;
      if (!owner) throw new Error('无法确认这本书的本机账号，请重新打开人物卡片。');
      if (reset) await resetCharacterAvatar(bookId, characterId, owner);
      else if (source) await saveCharacterAvatar(bookId, characterId, source, crop, owner);
      if (live.current) {
        replace();
        notify(reset ? '已恢复默认头像。' : '人物头像已保存。');
      }
    } catch (failure) {
      if (live.current) setError(errorText(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (busy || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function moveCrop(event: PointerEvent<HTMLDivElement>) {
    const previous = drag.current;
    if (!previous || previous.pointer !== event.pointerId || busy) return;
    const pixels = event.currentTarget.getBoundingClientRect().width;
    if (pixels <= 0) return;
    const dx = (event.clientX - previous.x) / pixels * side;
    const dy = (event.clientY - previous.y) / pixels * side;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    setFrame(value => ({ ...value, x: width ? limit(value.x - dx / width) : value.x, y: height ? limit(value.y - dy / height) : value.y }));
  }

  return <div className="portrait-editor">
    <div className="portrait-editor-actions">
      <label className="secondary portrait-file-picker">
        <ImagePlus size={16}/>{image ? '更换头像' : '上传头像'}
        <input type="file" aria-label="选择人物头像图片" accept="image/png,image/jpeg,image/webp" onChange={choose} disabled={busy}/>
      </label>
      {image && <>
        <button className="secondary" disabled={busy} onClick={() => void prepare(image)}>调整当前头像</button>
        <button className="text-button portrait-reset" disabled={busy} onClick={() => void commit(true)}><RotateCcw size={14}/>恢复默认头像</button>
      </>}
    </div>
    <p className="portrait-hint">支持 PNG、JPEG 和静态 WebP，原图最大 12 MiB。保存为 256 像素的正方形头像。</p>
    {source && <div className="portrait-crop-editor">
      <div className="portrait-crop-preview" aria-label="头像裁剪预览" role="img"
        onPointerDown={beginDrag} onPointerMove={moveCrop} onLostPointerCapture={() => { drag.current = undefined; }}>
        <img src={source.image.src} alt="" draggable={false} style={{
          width: `${source.width / side * 100}%`,
          height: `${source.height / side * 100}%`,
          left: `${-crop.x / side * 100}%`,
          top: `${-crop.y / side * 100}%`,
        }}/>
      </div>
      <div className="portrait-crop-controls">
        <p className="portrait-hint">拖动预览移动图片，也可用下方滑块调整。</p>
        <label>缩放<input type="range" aria-label="头像缩放" min={1} max={4} step={.01} value={frame.zoom}
          disabled={busy} onChange={event => { const zoom = Number(event.target.value); setFrame(value => ({ ...value, zoom })); }}/></label>
        <label>水平位置<input type="range" aria-label="头像水平位置" min={0} max={1} step={.005} value={frame.x}
          disabled={busy || width <= .001} onChange={event => { const x = Number(event.target.value); setFrame(value => ({ ...value, x })); }}/></label>
        <label>垂直位置<input type="range" aria-label="头像垂直位置" min={0} max={1} step={.005} value={frame.y}
          disabled={busy || height <= .001} onChange={event => { const y = Number(event.target.value); setFrame(value => ({ ...value, y })); }}/></label>
      </div>
      <div className="portrait-editor-actions">
        <button className="primary" disabled={busy} onClick={() => void commit(false)}><Check size={16}/>保存头像</button>
        <button className="secondary" disabled={busy} onClick={() => { setError(''); replace(); }}>取消裁剪</button>
      </div>
    </div>}
    {busy && <p className="portrait-hint" role="status">正在处理头像…</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
