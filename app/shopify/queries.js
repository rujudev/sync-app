/** ====================== GraphQL queries/mutations ====================== */
export const PRODUCT_SEARCH = `
  query searchProducts($query: String!) {
    products(first: 5, query: $query) {
      edges {
        node {
          id
          title
          vendor
          descriptionHtml
          handle
          tags
          options {
            id
            name
            position
            optionValues {
              id
              name
            }
          }
          variants(first: 50) {
            edges { node { id sku barcode selectedOptions { name value } } }
          }
          images(first: 20) {
            edges { node { id url } }
          }
        }
      }
    }
  }
`;

export const PRODUCT_CREATE = `
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
`;

export const PRODUCT_UPDATE = `
  mutation UpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        descriptionHtml
        tags
        vendor
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const PRODUCT_SET_CREATE = `
    mutation ProductSetInput($productSet: ProductSetInput!, $synchronous: Boolean!) {
        productSet(synchronous: $synchronous, input: $productSet) {
            product {
                id
            }
            productSetOperation {
                id
                status
                userErrors {
                    code
                    field
                    message
                }
            }
            userErrors {
                code
                field
                message
            }
        }
    }
`;

export const PRODUCT_CREATE_MEDIA = `
    mutation UpdateProductWithNewMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
        productUpdate(product: $product, media: $media) {
            product {
                id
                media(first: 10) {
                    nodes {
                        id
                        preview {
                            image {
                                id
                                url
                            }
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
`;

export const GET_PRODUCT_MEDIA = `
  query GetProductMedia($id: ID!) {
    product(id: $id) {
      id
      media(first: 100) {
        nodes {
          id
          preview {
            image {
              id
              url
            }
          }
        }
      }
    }
  }
`;

// ── ACTUALIZADO ── Se añade el parámetro `strategy` a la mutation.
// Con REMOVE_STANDALONE_VARIANT, Shopify elimina automáticamente la variante
// placeholder "Default Title" cuando se crea la primera variante real, sin
// necesidad de borrarla manualmente ni de gestionar las opciones genéricas
// por separado. Esto resuelve el error "Option does not exist" que ocurría
// cuando el producto tenía la opción Title en lugar de Capacidad/Color/Condición.
export const VARIANTS_CREATE = `
    mutation ProductVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
        productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
            product {
                id
            }
            productVariants {
                id
                title
                price
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
`;

export const VARIANTS_UPDATE = `
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
        price
        inventoryItem {
          id
          sku
        }
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
`;

export const GET_INVENTORY_ITEM = `
  query inventoryItem($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      inventoryItem {
        id
        sku
      }
    }
  }`;

export const SET_INVENTORY_ITEM = `
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        sku
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const GET_PRODUCT_VARIANTS = `
  query GetProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      options {
        id
        name
        position
        optionValues {
          id
          name
        }
      }
      variants(first: $first, after: $after) {
        nodes {
          id
          sku
          barcode
          price
          selectedOptions {
            name
            value
          }
          image {
            url
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const GET_PUBLICATIONS = `
  query GetPublications {
    publications(first: 10) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

export const PUBLISH_PRODUCT = `
  mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        availablePublicationsCount {
          count
        }
        resourcePublicationsCount {
          count
        }
      }
      shop {
        publicationCount
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const GET_COLLECTION_PRODUCTS = `
  query Products($cursor: String, $collectionId: ID!, $limit: Int!) {
    collection(id: $collectionId) {
      products(first: $limit, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
          }
        }
      }
    }
  }
`

export const REMOVE_PRODUCTS = `
  mutation RemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) { 
      userErrors {
        message
      }
    }
  }
`

export const ADD_PRODUCTS_TO_COLLECTION = `
  mutation AddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      userErrors {
        message
      }
    }
  }
`

/** ============================== Ordenes pagadas =================================== */

export const PAID_ORDERS_QUERY = `
  query Orders($cursor: String, $limit: Int = 50) {
    orders(first: $limit, after: $cursor, query: "financial_status:paid") {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node { 
          id
          createdAt
          lineItems(first: 250) {
            edges {
              node { 
                quantity
                product {
                  id
                  title
                }
              }
            }
          }
        }
      }
    }
  }
`

export const GET_COLLECTION_BY_HANDLE = `
  query GetCollectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
      title
      handle
    }
  }
`;

export const CREATE_COLLECTION = `
  mutation CreateCollection($title: String!, $handle: String!) {
    collectionCreate(input: {
      title: $title
      handle: $handle
    }) {
      collection {
        id
        title
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`

export const SET_PRODUCT_METAFIELDS = `
  mutation SetProductMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const METAFIELD_DEFINITION_CREATE = `
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        namespace
        key
        name
        type {
          name
          category  
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ── NUEVO ── Eliminar un producto completo de Shopify por ID.
// Se usa cuando todas las variantes de un grupo pasan a out_of_stock
// en el feed, lo que significa que no hay stock de ninguna variante
// y el producto no debe estar visible en la tienda.
export const PRODUCT_DELETE = `
  mutation DeleteProduct($id: ID!) {
    productDelete(input: { id: $id }) {
      deletedProductId
      userErrors {
        field
        message
      }
    }
  }
`;

// ── NUEVO ── Pagina todos los productos gestionados por la app (tag "cosladafon").
// Se usa en la reconciliación final para detectar productos huérfanos: los que
// tienen el tag pero cuyo modelo ya no aparece en ningún grupo del feed y que,
// por tanto, deben eliminarse de la tienda.
export const GET_PRODUCTS_BY_TAG = `
  query ProductsByTag($query: String!, $cursor: String) {
    products(first: 100, query: $query, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
        }
      }
    }
  }
`;

// ── NUEVO ── Crea opciones nuevas en un producto existente.
// Se usa cuando el producto en Shopify tiene solo la opción genérica "Title"
// (producto creado a medias en una sync anterior) y hay que añadir las opciones
// reales Capacidad, Color y Condición antes de poder crear variantes.
export const PRODUCT_OPTIONS_CREATE = `
  mutation productOptionsCreate(
    $productId: ID!
    $options: [OptionCreateInput!]!
  ) {
    productOptionsCreate(productId: $productId, options: $options) {
      product {
        id
        options {
          id
          name
          position
          optionValues {
            id
            name
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ── NUEVO ── Elimina una opción de un producto por ID.
// Se usa para eliminar la opción genérica "Title" tras crear las opciones reales.
export const PRODUCT_OPTION_DELETE = `
  mutation productOptionDelete($productId: ID!, $optionId: ID!) {
    productOptionDelete(productId: $productId, id: $optionId) {
      deletedOptionId
      product {
        id
        options {
          id
          name
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ── NUEVO ── Actualiza los valores de una opción existente de un producto.
// Se usa para sincronizar los valores disponibles (ej: capacidades, colores)
// antes de crear o actualizar variantes, evitando el error "Option does not
// exist" cuando el feed trae valores distintos a los que tiene Shopify.
export const PRODUCT_OPTION_UPDATE = `
  mutation productOptionUpdate(
    $productId: ID!
    $option: OptionUpdateInput!
    $optionValuesToAdd: [OptionValueCreateInput!]
    $optionValuesToDelete: [ID!]
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToAdd: $optionValuesToAdd
      optionValuesToDelete: $optionValuesToDelete
    ) {
      product {
        id
        options {
          id
          name
          optionValues {
            id
            name
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const METAFIELD_DEFINITION_UPDATE = `
  mutation UpdateMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition {
        id
        namespace
        key
        name
        capabilities {
          adminFilterable {
            enabled
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;