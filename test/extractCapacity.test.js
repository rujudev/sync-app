import { extractCapacityFromString, extractCapacity } from '../app/services/attributes-utils.js';
import { test, expect } from 'vitest';

test('extractCapacityFromString picks storage capacity from titles', () => {
  const titles = [
    'Xiaomi Redmi Note 12 Pro 5G 6GB 128GB Midnight Black (Negro)',
    'Xiaomi Redmi Note 11 6Gb 128Gb Graphite Gray (Gris)',
    'Xiaomi Redmi Note 11 Pro 5g 6Gb 128Gb Graphite Gray (Gris)',
    'Samsung Galaxy A52 6GB 5G (A526F/DS) 128GB Awesome White (Blanco)'
  ];

  titles.forEach(t => {
    const out = extractCapacityFromString(t);
    console.log(out)
    expect(out).toBe('128GB');
  });
});
