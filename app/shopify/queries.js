/** ====================== GraphQL queries/mutations ====================== */
export const PRODUCT_SEARCH = `
  query searchProducts($query: String!) {
    products(first: 5, query: $query) {
      edges {
        node {
          id
          title
          handle
          tags
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

export const VARIANTS_CREATE = `
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

export const GET_PRODUCT_VARIANTS = `
    query ProductVariantsList($query: String!) {
        productVariants(first: 10, query: $query) {
            nodes {
                id
                title
                barcode
                price
                selectedOptions {
                    name
                    value
                }
            }
            pageInfo {
                startCursor
                endCursor
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