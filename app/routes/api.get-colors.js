import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const query = `
    query GetProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
        }
        edges {
          cursor
          node {
            variants(first: 250) {
              nodes {
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  let allColors = new Set();
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const res = await admin.graphql(query, {
      variables: { first: 50, after: cursor }
    });

    const data = await res.json();
    const products = data?.data?.products;

    // Añadir colores
    for (const edge of products.edges) {
      for (const variant of edge.node.variants.nodes) {
        const colorOpt = variant.selectedOptions.find(o => o.name.toLowerCase() === "color");
        if (colorOpt) {
          allColors.add(colorOpt.value.trim());
        }
      }
    }

    // Avanzar cursor
    hasNext = products.pageInfo.hasNextPage;
    if (hasNext) {
      cursor = products.edges[products.edges.length - 1].cursor;
    }
  }

  return Response.json({
    success: true,
    colors: Array.from(allColors)
  });
};
