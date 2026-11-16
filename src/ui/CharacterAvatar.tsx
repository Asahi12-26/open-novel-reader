import { memo, useEffect, useState, type CSSProperties } from 'react';
import { UserRound, UserRoundSearch } from 'lucide-react';
import type { Character } from '../types';
import './character-visuals.css';

const portraits = new WeakMap<Blob, { url: string; users: number }>();
const palette = [
  ['#385a50', '#d9e5da'], ['#76533e', '#f2dfca'], ['#4d596e', '#dce3ee'],
  ['#785162', '#f0dde7'], ['#586841', '#e2e8d0'], ['#765745', '#ecd4c2'],
  ['#4a6872', '#d5e7e8'], ['#655375', '#e5daee'], ['#71603b', '#ede4c1'],
  ['#4f5751', '#d9ded5'], ['#713f4a', '#ecd3d4'], ['#41596b', '#cedde9'],
] as const;

function portraitTone(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % palette.length;
}

function usePortraitUrl(blob?: Blob) {
  const [loaded, setLoaded] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) return;
    const entry = portraits.get(blob) || { url: URL.createObjectURL(blob), users: 0 };
    entry.users++;
    portraits.set(blob, entry);
    setLoaded({ blob, url: entry.url });
    return () => {
      if (--entry.users) return;
      URL.revokeObjectURL(entry.url);
      portraits.delete(blob);
    };
  }, [blob]);
  return loaded?.blob === blob ? loaded?.url : undefined;
}

interface AvatarProps {
  character?: Pick<Character, 'id' | 'name'>;
  image?: Blob;
  size?: 'inline' | 'card' | 'editor';
}

/** Decorative portrait; its containing control supplies the accessible name. */
export const CharacterAvatarView = memo(function CharacterAvatarView({ character, image, size = 'card' }: AvatarProps) {
  const url = usePortraitUrl(character ? image : undefined);
  const [brokenUrl, setBrokenUrl] = useState('');
  const [ink, paper] = character ? palette[portraitTone(character.id)] : ['#666c65', '#e5e4dd'];
  const custom = !!url && url !== brokenUrl;
  const style = { '--portrait-ink': ink, '--portrait-paper': paper } as CSSProperties;
  return <span className={`character-portrait character-portrait--${size}`} aria-hidden="true" data-custom-avatar={custom} style={style}>
    {custom ? <img src={url} alt="" loading={size === 'editor' ? 'eager' : 'lazy'} decoding="async" onError={() => setBrokenUrl(url)}/>
      : character ? <UserRound strokeWidth={1.45}/> : <UserRoundSearch strokeWidth={1.45}/>}
  </span>;
}, (before, after) => before.character?.id === after.character?.id && before.image === after.image && before.size === after.size);
