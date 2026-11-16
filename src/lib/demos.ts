import { readSource } from './image';

export const DEMOS = [
  { file: 'fashion-poster.jpg', title: 'Fashion poster' },
  { file: 'product-ad.jpg', title: 'Product ad' },
  { file: 'restaurant-post.jpg', title: 'Restaurant post' },
  { file: 'event-announcement.jpg', title: 'Event announcement' },
  { file: 'text-heavy-promo.png', title: 'Text-heavy promo' },
];

export function demoUrl(file: string) {
  return new URL(`demo/${file}`, new URL(import.meta.env.BASE_URL, document.baseURI)).href;
}

export async function loadDemo(file: string) {
  const res = await fetch(demoUrl(file));
  if (!res.ok) throw new Error(`Demo image missing (${res.status}).`);
  return readSource(await res.blob(), file);
}
