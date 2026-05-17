import fs from 'fs';
import path from 'path';
import { expect, test } from 'vitest';
import {
    buildShopifyProductObject,
    groupByModelKey,
    normalizeFeedItem,
    parseXmlItems
} from '../app/services/xml-sync.server.js';

const xmlPath = path.resolve(process.cwd(), 'productos.xml');
const xml = fs.readFileSync(xmlPath, 'utf8');

test('buildShopifyProductObject provide products with price > 180', () => {
    const items = parseXmlItems(xml);
    const normalized = items.map(normalizeFeedItem).filter(Boolean);
    const groups = groupByModelKey(normalized);


    for (const [key, group] of Object.entries(groups).slice(0, 1)) {
        console.log(`Processing group: ${key} with ${group.length} items`); // Log para verificar cada grupo
        expect(group.length).toBe(4); // Esperamos 4 elementos en el grupo

        const productObj = buildShopifyProductObject(group);

        // expect(productObj.variants.length).toBe(3); // Verificamos que el producto construido tenga 4 variantes

        productObj.variants.forEach(variant => {
            const price = parseFloat(variant.price);
            expect(price).toBeGreaterThan(180);
        });
    }
});
