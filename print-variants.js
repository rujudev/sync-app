import {
    groupByModelCapacityColor,
    normalizeProductsWithAttributes
} from './app/services/product-attributes.js';

const productos = [
  { title: 'Samsung Galaxy S23 Ultra 512Gb Sky Blue (Azul)', condition: 'used' },
  { title: 'Google Pixel 10 128GB Obsidian (Negro)', condition: 'refurbished' },
  { title: 'Google Pixel 10 256GB Obsidian (Negro)', condition: 'refurbished' },
  { title: 'Google Pixel 10 Pro 128GB Obsidiana (Negro)', condition: 'refurbished' },
  { title: 'Google Pixel 10 Pro 256GB Obsidiana (Negro)', condition: 'refurbished' },
  { title: 'Google Pixel 9 Pro Fold 256GB Black (Negro)', condition: 'refurbished' },
  { title: 'Google Pixel 9 Pro Fold 512GB Black (Negro)', condition: 'refurbished' },
  { title: 'Samsung Galaxy S25 FE 128GB Black (Negro)', condition: 'refurbished' },
  { title: 'Samsung Galaxy S25 FE 256GB Black (Negro)', condition: 'refurbished' },
  { title: 'Samsung Galaxy S25 FE 512GB Black (Negro)', condition: 'refurbished' }
];

const normalizados = normalizeProductsWithAttributes(productos);
const grupos = groupByModelCapacityColor(normalizados);

grupos.forEach(grupo => {
  const variante = grupo[0];
  console.log('='.repeat(40));
  console.log(`MODELO: ${variante.model.toUpperCase()}`);
  console.log('- Variantes:');
  grupo.forEach(v => {
    console.log(`   • Capacidad: ${v.capacity.padEnd(8)} | Color: ${v.color.padEnd(12)} | Condición: ${v.condition}`);
  });
  console.log('='.repeat(40) + '\n');
});
