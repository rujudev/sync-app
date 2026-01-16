import { adminGraphql } from "../services/xml-sync.server";
import { ADD_PRODUCTS_TO_COLLECTION, CREATE_COLLECTION, GET_COLLECTION_BY_HANDLE, GET_COLLECTION_PRODUCTS, GET_PUBLICATIONS, PAID_ORDERS_QUERY, PUBLISH_PRODUCT, REMOVE_PRODUCTS } from "../shopify/queries";

const LIMIT = "50";

const fetchAllPaidOrders = async (admin) => {
    let orders = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
        const response = await admin.graphql(
            PAID_ORDERS_QUERY,
            { cursor, limit: 100 }
        );

        const { data } = await response.json();

        const { orders: ordersPage } = data;

        hasNextPage = ordersPage.pageInfo?.hasNextPage ?? false;
        cursor = ordersPage.pageInfo?.endCursor ?? null;

        if (!Array.isArray(ordersPage.edges)) {
            throw new Error("Invalid GraphQL response: edges is not an array");
        }

        ordersPage.edges.forEach(({ node }) => {
            if (node) orders.push(node);
        });
    }

    return orders;
};

const calculateTopSales = (orders) => {
    const salesMap = new Map();

    orders.forEach(order => {
        order.lineItems.edges.forEach(({ node }) => {
            if (!node.product) return;

            const productId = node.product.id;

            if (!salesMap.has(productId)) {
                salesMap.set(productId, {
                    productId,
                    title: node.product.title,
                    units: 0
                });
            }

            salesMap.set(productId, {
                ...salesMap.get(productId),
                units: salesMap.get(productId).units + node.quantity
            });
        });
    });

    return Array.from(salesMap.values())
        .sort((a, b) => b.units - a.units)
        .slice(0, LIMIT);
}

const getOrCreateCollection = async (admin) => {
    const collectionResult = await adminGraphql(admin, GET_COLLECTION_BY_HANDLE, { handle: 'top-ventas' });
    const { data: collection } = await collectionResult.json();

    if (collection.collectionByHandle) {
        console.log('📁 Colección existente encontrada:', collection.collectionByHandle);
        return collection.collectionByHandle.id;
    }

    const createCollectionResult = await adminGraphql(admin, CREATE_COLLECTION, {
        title: 'Top Ventas',
        handle: 'top-ventas'
    });

    const { data: createdCollection } = await createCollectionResult.json();

    if (createdCollection.collectionCreate.userErrors.length > 0) {
        console.error('❌ Error al crear colección:', createdCollection.collectionCreate.userErrors);
        throw new Error('Error al crear colección');
    }

    console.log('✅ Colección creada:', createdCollection.collectionCreate.collection);
    const collectionId = createdCollection.collectionCreate.collection.id;

    // Publicar la colección recién creada
    const publicationsResult = await adminGraphql(admin, GET_PUBLICATIONS);
    const { data: publicationsData } = await publicationsResult.json();
    const publicationsIDs = publicationsData.publications.edges.map(({ node }) => ({
        publicationId: node.id
    }));

    await adminGraphql(admin, PUBLISH_PRODUCT, {
        id: collectionId,
        input: publicationsIDs
    });

    return collectionId;
}

const clearCollection = async (admin, collectionId) => {
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
        const productsResult = await adminGraphql(admin, GET_COLLECTION_PRODUCTS, { cursor, collectionId, limit: 50 });
        const { data } = await productsResult.json();

        const products = data.collection.products;
        hasNextPage = products.pageInfo.hasNextPage;
        cursor = products.pageInfo.endCursor;

        const productIds = products.edges.map(edge => edge.node.id);

        if (productIds.length === 0) break;

        await adminGraphql(admin, REMOVE_PRODUCTS, {
            collectionId,
            productIds
        });
    }
}

const addProductsToCollection = async (admin, collectionId, productIds) => {
    if (productIds.length === 0) {
        console.log('⚠️ No hay productos para añadir a la colección');
        return;
    }

    console.log(`✅ Añadiendo ${productIds.length} productos a la colección...`);

    const result = await adminGraphql(admin, ADD_PRODUCTS_TO_COLLECTION, {
        collectionId,
        productIds
    });

    const { data } = await result.json();

    if (data.collectionAddProducts.userErrors.length > 0) {
        console.error('❌ Error al añadir productos:', data.collectionAddProducts.userErrors);
    } else {
        console.log('✅ Productos añadidos exitosamente');
    }
}

export const updateBestSellersCollection = async (admin) => {
    try {
        /** Obtener ordenes */
        const orders = await fetchAllPaidOrders(admin);

        console.log('📦 Total de órdenes:', orders.length);

        /** Calcular top ventas */
        const topSales = calculateTopSales(orders);

        console.log(`🏆 Top ${topSales.length} productos más vendidos:`);
        topSales.forEach((sale, i) => {
            console.log(`  ${i + 1}. ${sale.title} - ${sale.units} unidades`);
        });

        /** Obtener o crear coleccion */
        const collectionId = await getOrCreateCollection(admin);
        console.log('📁 ID de colección:', collectionId);

        /** Limpiar coleccion */
        await clearCollection(admin, collectionId);

        /** Agregar productos a la coleccion */
        const productIds = topSales.map(sale => sale.productId);
        console.log('🔗 IDs de productos a añadir:', productIds);
        await addProductsToCollection(admin, collectionId, productIds);

        return {
            success: true,
            ordersCount: orders.length,
            topSales: topSales,
            collectionId,
            productsAdded: productIds.length
        };
    } catch (error) {
        console.error('❌ Error en updateBestSellersCollection:', error);
        return {
            success: false,
            error: error.message || 'Error desconocido'
        };
    }
}