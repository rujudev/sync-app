import { parseXmlItems, normalizeFeedItem, groupByModelKey, buildShopifyProductObject } from '../app/services/xml-sync.server.js';
import { test, expect } from 'vitest';

const NOTE_20_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <item>
      <g:id>5876</g:id>
      <g:title>Samsung Galaxy Note 20 256GB Mystic Bronze (Bronce)</g:title>
      <g:description>El Samsung Galaxy Note 20 5G (SM-N981B/DS) es un móvil Android bueno...</g:description>
      <g:link>https://www.cosladafon.com/producto/samsung-galaxy-note-20-256gb-mystic-bronze-bronce</g:link>
      <g:image_link>https://www.cosladafon.com/uploads/productos/N204G256BRONCEBE_1X.webp</g:image_link>
      <g:item_group_id>8806090597145</g:item_group_id>
      <g:availability>out_of_stock</g:availability>
      <g:price>269.00 EUR</g:price>
      <g:sale_price>239.00 EUR</g:sale_price>
      <g:color>bronce</g:color>
      <g:condition>used</g:condition>
      <g:brand>Samsung</g:brand>
      <g:gtin>8806090597145</g:gtin>
      <g:shipping>
        <g:country>ES</g:country>
        <g:service>Estandard</g:service>
        <g:price>0.00 EUR</g:price>
      </g:shipping>
      <g:adult>no</g:adult>
    </item>
  </channel>
</rss>`;

test('complete Note 20 flow parses XML, normalizes item, groups by model, and builds Shopify product with correct sale_price-derived variant', () => {
  const items = parseXmlItems(NOTE_20_XML);
  expect(items).toHaveLength(1);

  const normalized = normalizeFeedItem(items[0]);
  expect(normalized.price).toBe(239);
  expect(normalized.modelTitle).toContain('Samsung Galaxy Note 20');

  const group = groupByModelKey([normalized]);
  const groupItems = Object.values(group)[0];
  const productObj = buildShopifyProductObject(groupItems);

  expect(productObj.variants).toHaveLength(1);
  expect(productObj.variants[0]).toMatchObject({
    sku: '5876',
    barcode: '8806090597145',
    price: 299,
    inventoryPolicy: 'CONTINUE',
    optionValues: [
      { optionName: 'Capacidad', name: '256GB' },
      { optionName: 'Color', name: 'bronce' },
      { optionName: 'Condición', name: 'usado' }
    ]
  });
});

test('groupByModelKey keeps separate groups when modelKey collides but item_group_id differs', () => {
  const itemA = {
    sku: '1',
    title: 'Google Pixel 10 Pro 128GB White',
    brand: 'Google',
    groupId: 'G10P-1',
    modelTitle: 'Google Pixel 10 Pro',
    modelKey: 'google pixel 10 pro'
  };
  const itemB = {
    sku: '2',
    title: 'Google Pixel 10 Pro 128GB Blue',
    brand: 'Google',
    groupId: 'G10P-2',
    modelTitle: 'Google Pixel 10 Pro',
    modelKey: 'google pixel 10 pro'
  };

  const groups = groupByModelKey([itemA, itemB]);
  expect(Object.keys(groups)).toEqual(['G10P-1', 'G10P-2']);
  expect(groups['G10P-1']).toHaveLength(1);
  expect(groups['G10P-2']).toHaveLength(1);
});
