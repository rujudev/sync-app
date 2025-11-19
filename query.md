
# Ejemplo profesional de petición GraphQL para crear producto en Shopify

---

## 1. Creación de producto con opciones iniciales

```graphql
mutation CreateProduct($product: ProductCreateInput!) {
  productCreate(product: $product) {
    product { 
      id 
      title
      handle
      descriptionHtml 
      tags 
      options {
        id
        name
        values
        position
        optionValues {
          id
          name
        }
      }
    }
    userErrors { field message }
  }
}
```

---


### 1.1 Variables de entrada para producto

```json
{
  "product": {
    "title": "Nuevo producto de prueba",
    "handle": "producto-prueba-6",
    "descriptionHtml": "El nuevo producto de prueba es muy chulo",
    "tags": ["producto", "prueba", "chulo"],
    "productOptions": [
      { "name": "Capacidad", "values": [{ "name": "128GB" }, { "name": "256GB" }] },
      { "name": "Color", "values": [{ "name": "negro" }, { "name": "blanco" }] }
    ]
  }
}
```

### 1.2 Respuesta

```json
{
  "data": {
    "productCreate": {
      "product": {
        "id": "gid://shopify/Product/8658059591858",
        "title": "Nuevo producto de prueba",
        "handle": "producto-prueba-6",
        "descriptionHtml": "El nuevo producto de prueba es muy chulo",
        "tags": [
          "chulo",
          "producto",
          "prueba"
        ],
        "options": [
          {
            "id": "gid://shopify/ProductOption/11038244274354",
            "name": "Capacidad",
            "values": [
              "128GB"
            ],
            "position": 1,
            "optionValues": [
              {
                "id": "gid://shopify/ProductOptionValue/4033955266738",
                "name": "128GB",
                "hasVariants": true
              },
              {
                "id": "gid://shopify/ProductOptionValue/4033955299506",
                "name": "256GB",
                "hasVariants": false
              }
            ]
          },
          {
            "id": "gid://shopify/ProductOption/11038244307122",
            "name": "Color",
            "values": [
              "negro"
            ],
            "position": 2,
            "optionValues": [
              {
                "id": "gid://shopify/ProductOptionValue/4033955332274",
                "name": "negro",
                "hasVariants": true
              },
              {
                "id": "gid://shopify/ProductOptionValue/4033955365042",
                "name": "blanco",
                "hasVariants": false
              }
            ]
          }
        ]
      },
      "userErrors": []
    }
  }
}
```

---

## 3. Mutation: Creación masiva de variantes

```graphql
mutation ProductVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants) {
    product {
      id
    }
    productVariants {
      id
      title
      selectedOptions {
        name
        value
      }
    }
    userErrors {
      field
      message
    }
  }
}
```

### 3.1 Variables de entrada para variantes

```json
{
  "productId": "gid://shopify/Product/8658059591858",
  "variants": [
    {
      "price": 15.00,
      "optionValues": [
        {
          "name": "128GB",
          "optionName": "Capacidad"
        },
        {
          "name": "blanco",
          "optionName": "Color"
        }
      ]
    }
  ]
}
```

### 3.2 Respuesta a la creación de las variantes

```json
"data": {
    "productVariantsBulkCreate": {
      "product": {
        "id": "gid://shopify/Product/8658059591858"
      },
      "userErrors": [],
      "productVariants": [
        {
          "id": "gid://shopify/ProductVariant/46738102714546",
          "title": "128GB / blanco",
          "selectedOptions": [
            {
              "name": "Capacidad",
              "value": "128GB"
            },
            {
              "name": "Color",
              "value": "blanco"
            }
          ]
        }
      ]
    }
  }
```

## 4. Mutación. Actualización de las variantes del producto en modo Bulk

```graphql
mutation UpdateProductVariantsOptionValuesInBulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    product {
      id
      title
      options {
        id
        position
        name
        values
        optionValues {
          id
          name
          hasVariants
        }
      }
    }
    productVariants {
      id
      title
      selectedOptions {
        name
        value
      }
    }
    userErrors {
      field
      message
    }
  }
}
```

### 4.1 Variables de entrada

```json
{
  "productId": "gid://shopify/Product/8658059591858",
  "variants": [
      {
          "id": "gid://shopify/ProductVariant/46736023257266",
          "optionValues": [
              {
                  "name": "256GB",
                  "optionName": "Capacidad"
              }
          ]
      }
  ]
}
```

### Respuesta

```json
"data": {
    "productVariantsBulkUpdate": {
      "product": {
        "id": "gid://shopify/Product/8658059591858",
        "title": "Nuevo producto de prueba",
        "options": [
          {
            "id": "gid://shopify/ProductOption/11038244274354",
            "position": 1,
            "name": "Capacidad",
            "values": [
              "128GB",
              "256GB"
            ],
            "optionValues": [
              {
                "id": "gid://shopify/ProductOptionValue/4033955266738",
                "name": "128GB",
                "hasVariants": true
              },
              {
                "id": "gid://shopify/ProductOptionValue/4033955299506",
                "name": "256GB",
                "hasVariants": true
              }
            ]
          },
          {
            "id": "gid://shopify/ProductOption/11038244307122",
            "position": 2,
            "name": "Color",
            "values": [
              "negro",
              "blanco"
            ],
            "optionValues": [
              {
                "id": "gid://shopify/ProductOptionValue/4033955332274",
                "name": "negro",
                "hasVariants": true
              },
              {
                "id": "gid://shopify/ProductOptionValue/4033955365042",
                "name": "blanco",
                "hasVariants": true
              }
            ]
          }
        ]
      },
      "productVariants": [
        {
          "id": "gid://shopify/ProductVariant/46736023257266",
          "title": "256GB / blanco",
          "selectedOptions": [
            {
              "name": "Capacidad",
              "value": "256GB"
            },
            {
              "name": "Color",
              "value": "blanco"
            }
          ]
        }
      ],
      "userErrors": []
    }
  }
```

## 5. Mutation. Creación masiva de imágenes para el producto

```graphql
mutation UpdateProductWithNewMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
    product {
      id
      media(first: 10) {
        nodes {
          alt
          mediaContentType
          preview {
            status
          }
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
```

### 5.1 Variables de entrada

```json
{
  "product": {
    "id": "gid://shopify/Product/8658059591858"
  },
  "media": [
    {
      "originalSource": "https://www.cosladafon.com/uploads/productos/S25E512NEGROCN_0.webp",
      "alt": "Gray helmet for bikers",
      "mediaContentType": "IMAGE"
    }
  ]
}
```

### Respuesta

```json
"data": {
    "productVariantsBulkUpdate": {
      "product": {
        "id": "gid://shopify/Product/8658059591858",
        "title": "Nuevo producto de prueba",
        "options": [
          {
            "id": "gid://shopify/ProductOption/11038244274354",
            "position": 1,
            "name": "Capacidad",
            "values": [
              "128GB",
              "256GB"
            ],
            "optionValues": [
              {
                "id": "gid://shopify/ProductOptionValue/4033955266738",
                "name": "128GB",
                "hasVariants": true
              },
              {
                "id": "gid://shopify/ProductOptionValue/4033955299506",
                "name": "256GB",
                "hasVariants": true
              }
            ]
          },
          {
            "id": "gid://shopify/ProductOption/11038244307122",
            "position": 2,
            "name": "Color",
            "values": [
              "negro",
              "blanco"
            ],
            "optionValues": [
              {
                "id": "gid://shopify/ProductOptionValue/4033955332274",
                "name": "negro",
                "hasVariants": true
              },
              {
                "id": "gid://shopify/ProductOptionValue/4033955365042",
                "name": "blanco",
                "hasVariants": true
              }
            ]
          }
        ]
      },
      "productVariants": [
        {
          "id": "gid://shopify/ProductVariant/46736023257266",
          "title": "256GB / blanco",
          "selectedOptions": [
            {
              "name": "Capacidad",
              "value": "256GB"
            },
            {
              "name": "Color",
              "value": "blanco"
            }
          ]
        }
      ],
      "userErrors": []
    }
  }
```

---

> **Nota:**
> - El bloque de mutation define la operación GraphQL.
> - El bloque de variables contiene el objeto que se envía como `$product`.
> - Revisa la documentación oficial de Shopify para los campos permitidos en `ProductCreateInput`.