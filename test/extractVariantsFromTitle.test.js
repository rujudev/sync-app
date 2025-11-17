/* eslint-env jest */
import {
    extractAttributesFromTitle,
    extractModel,
    groupByModelCapacityColor,
    normalizeProductsWithAttributes
} from '../app/services/product-attributes.js';

describe('Extracción de variantes desde el título', () => {
  it('extrae correctamente atributos de títulos variados y compuestos', () => {
    const productos = [
      {
        title: 'Samsung Galaxy S23 Ultra 512Gb Sky Blue (Azul)',
        price: 569.00,
        sku: '5530',
      },
      {
        title: 'Google Pixel 10 128GB Obsidian (Negro)',
        price: 629.00,
        sku: '5518',
      },
      {
        title: 'Google Pixel 10 256GB Obsidian (Negro)',
        price: 729.00,
        sku: '5519',
      },
      {
        title: 'Google Pixel 10 Pro 128GB Obsidiana (Negro)',
        price: 899.00,
        sku: '5520',
      },
      {
        title: 'Google Pixel 10 Pro 256GB Obsidiana (Negro)',
        price: 979.00,
        sku: '5521',
      },
      {
        title: 'Google Pixel 9 Pro Fold 256GB Black (Negro)',
        price: 929.00,
        sku: '5516',
      },
      {
        title: 'Google Pixel 9 Pro Fold 512GB Black (Negro)',
        price: 979.00,
        sku: '5517',
      }
    ];
    const normalizados = normalizeProductsWithAttributes(productos);
    expect(normalizados[0]).toMatchObject({
      model: 'Samsung Galaxy S23 Ultra',
      capacity: '512Gb',
      color: 'Sky Blue',
      colorTranslation: 'Azul'
    });
    expect(normalizados[1]).toMatchObject({
      model: 'Google Pixel 10',
      capacity: '128GB',
      color: 'Obsidian',
      colorTranslation: 'Negro'
    });
    expect(normalizados[2]).toMatchObject({
      model: 'Google Pixel 10',
      capacity: '256GB',
      color: 'Obsidian',
      colorTranslation: 'Negro'
    });
    expect(normalizados[3]).toMatchObject({
      model: 'Google Pixel 10 Pro',
      capacity: '128GB',
      color: 'Obsidiana',
      colorTranslation: 'Negro'
    });
    expect(normalizados[4]).toMatchObject({
      model: 'Google Pixel 10 Pro',
      capacity: '256GB',
      color: 'Obsidiana',
      colorTranslation: 'Negro'
    });
    expect(normalizados[5]).toMatchObject({
      model: 'Google Pixel 9 Pro Fold',
      capacity: '256GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[6]).toMatchObject({
      model: 'Google Pixel 9 Pro Fold',
      capacity: '512GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
  });
  it('extrae y agrupa correctamente variantes Google Pixel y Samsung Galaxy S25 FE', () => {
    const productos = [
      {
        title: 'Google Pixel 8 Pro 256GB Porcelain (Blanco)',
        price: 459.00,
        sku: '5529',
      },
      {
        title: 'Google Pixel 8a 256GB Black (Negro)',
        price: 399.00,
        sku: '5510',
      },
      {
        title: 'Google Pixel 8 256 GB Obsidian (Negro)',
        price: 499.00,
        sku: '5511',
      },
      {
        title: 'Google Pixel 7a 128GB Black (Negro)',
        price: 199.00,
        sku: '5512',
      },
      {
        title: 'Google Pixel 7 256GB Black (Negro)',
        price: 299.00,
        sku: '5513',
      },
      {
        title: 'Google Pixel 6 128GB Black (Negro)',
        price: 189.00,
        sku: '5514',
      },
      {
        title: 'Google Pixel 6a 128GB Black (Negro)',
        price: 179.00,
        sku: '5515',
      },
      {
        title: 'Samsung Galaxy S25 FE 128GB Black (Negro)',
        price: 429.00,
        sku: '5526',
      },
      {
        title: 'Samsung Galaxy S25 FE 256GB Black (Negro)',
        price: 529.00,
        sku: '5527',
      },
      {
        title: 'Samsung Galaxy S25 FE 512GB Black (Negro)',
        price: 729.00,
        sku: '5528',
      }
    ];
    const normalizados = normalizeProductsWithAttributes(productos);
    expect(normalizados[0]).toMatchObject({
      model: 'Google Pixel 8 Pro',
      capacity: '256GB',
      color: 'Porcelain',
      colorTranslation: 'Blanco'
    });
    expect(normalizados[1]).toMatchObject({
      model: 'Google Pixel 8a',
      capacity: '256GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[2]).toMatchObject({
      model: 'Google Pixel 8',
      capacity: '256 GB',
      color: 'Obsidian',
      colorTranslation: 'Negro'
    });
    expect(normalizados[3]).toMatchObject({
      model: 'Google Pixel 7a',
      capacity: '128GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[4]).toMatchObject({
      model: 'Google Pixel 7',
      capacity: '256GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[5]).toMatchObject({
      model: 'Google Pixel 6',
      capacity: '128GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[6]).toMatchObject({
      model: 'Google Pixel 6a',
      capacity: '128GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[7]).toMatchObject({
      model: 'Samsung Galaxy S25 FE',
      capacity: '128GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[8]).toMatchObject({
      model: 'Samsung Galaxy S25 FE',
      capacity: '256GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[9]).toMatchObject({
      model: 'Samsung Galaxy S25 FE',
      capacity: '512GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    const grupos = groupByModelCapacityColor(normalizados);
    expect(grupos.length).toBe(10); // Cada combinación es única
    grupos.forEach(grupo => {
      expect(grupo.length).toBe(1);
    });
  });
  it('extrae y agrupa correctamente variantes Samsung Galaxy S25 FE Black (Negro)', () => {
    const productos = [
      {
        title: 'Samsung Galaxy S25 FE 128GB Black (Negro)',
        price: 429.00,
        sku: '5526',
      },
      {
        title: 'Samsung Galaxy S25 FE 256GB Black (Negro)',
        price: 529.00,
        sku: '5527',
      },
      {
        title: 'Samsung Galaxy S25 FE 512GB Black (Negro)',
        price: 729.00,
        sku: '5528',
      }
    ];
    const normalizados = normalizeProductsWithAttributes(productos);
    expect(normalizados[0]).toMatchObject({
      model: 'Samsung Galaxy S25 FE',
      capacity: '128GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[1]).toMatchObject({
      model: 'Samsung Galaxy S25 FE',
      capacity: '256GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    expect(normalizados[2]).toMatchObject({
      model: 'Samsung Galaxy S25 FE',
      capacity: '512GB',
      color: 'Black',
      colorTranslation: 'Negro'
    });
    const grupos = groupByModelCapacityColor(normalizados);
    expect(grupos.length).toBe(3); // Cada combinación es única
    grupos.forEach(grupo => {
      expect(grupo.length).toBe(1);
      expect(grupo[0].model).toBe('Samsung Galaxy S25 FE');
      expect(grupo[0].color).toBe('Black');
      expect(grupo[0].colorTranslation).toBe('Negro');
    });
  });

  it('extrae atributos correctamente de cada título S23 Ultra', () => {
    const productos = [
      {
        title: 'Samsung Galaxy S23 Ultra 512Gb Sky Blue (Azul)',
        price: 1200,
        sku: 'S23U-512GB-SB',
      },
      {
        title: 'Samsung Galaxy S23 Ultra 256Gb Graphite (Gris)',
        price: 1100,
        sku: 'S23U-256GB-GR',
      },
      {
        title: 'Samsung Galaxy S23 Ultra 512Gb Black (Negro)',
        price: 1200,
        sku: 'S23U-512GB-BK',
      }
    ];
    const normalizados = normalizeProductsWithAttributes(productos);
    expect(normalizados[0]).toMatchObject({
      model: 'Samsung Galaxy S23 Ultra',
      capacity: '512Gb',
      color: 'Sky Blue',
      colorTranslation: 'Azul'
    });
    expect(normalizados[1]).toMatchObject({
      model: 'Samsung Galaxy S23 Ultra',
      capacity: '256Gb',
      color: 'Graphite',
      colorTranslation: 'Gris'
    });
    expect(normalizados[2]).toMatchObject({
      model: 'Samsung Galaxy S23 Ultra',
      capacity: '512Gb',
      color: 'Black',
      colorTranslation: 'Negro'
    });
  });

  it('extrae atributos individuales del título S23 Ultra', () => {
    const title = 'Samsung Galaxy S23 Ultra 512Gb Sky Blue (Azul)';
    const attrs = extractAttributesFromTitle(title);
    expect(attrs).toMatchObject({
      capacity: '512Gb',
      color: 'Sky Blue',
      colorTranslation: 'Azul'
    });
    const model = extractModel(title);
    expect(model).toBe('Samsung Galaxy S23 Ultra');
  });

  it('agrupa variantes por modelo, capacidad y color S23 Ultra', () => {
    const productos = [
      {
        title: 'Samsung Galaxy S23 Ultra 512Gb Sky Blue (Azul)',
        price: 1200,
        sku: 'S23U-512GB-SB',
      },
      {
        title: 'Samsung Galaxy S23 Ultra 256Gb Graphite (Gris)',
        price: 1100,
        sku: 'S23U-256GB-GR',
      },
      {
        title: 'Samsung Galaxy S23 Ultra 512Gb Black (Negro)',
        price: 1200,
        sku: 'S23U-512GB-BK',
      }
    ];
    const normalizados = normalizeProductsWithAttributes(productos);
    const grupos = groupByModelCapacityColor(normalizados);
    expect(grupos.length).toBe(3); // Cada combinación es única
    grupos.forEach(grupo => {
      expect(grupo.length).toBe(1); // Cada grupo tiene una variante
    });
  });
});