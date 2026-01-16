import { useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
    try {
        const { admin } = await authenticate.admin(request);
        const { updateBestSellersCollection } = await import("../services/best-sellers.js");

        const result = await updateBestSellersCollection(admin);

        return Response.json(result);
    } catch (err) {
        console.error('❌ Error en action:', err);
        return Response.json({
            success: false,
            error: err.message || 'Error desconocido'
        }, { status: 500 });
    }
}

export const loader = async ({ request }) => {
    const { session } = await authenticate.admin(request);

    const shopDomain = session.shop.replace('.myshopify.com', '');

    return Response.json({
        shop: shopDomain,
        sessionId: session.id
    });
};

export default function BestSellers() {
    const fetcher = useFetcher();
    const [showAllProducts, setShowAllProducts] = useState(false);

    const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
    const data = fetcher.data;

    return (
        <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ marginBottom: '32px' }}>
                <h1 style={{ fontSize: '28px', fontWeight: '600', marginBottom: '8px' }}>
                    🏆 Actualizar Top Ventas
                </h1>
                <p style={{ color: '#6b7280', fontSize: '14px' }}>
                    Analiza las órdenes pagadas y actualiza automáticamente la colección Top Ventas
                </p>
            </div>

            {/* Action Button */}
            <fetcher.Form method="post">
                <s-button
                    variant="primary"
                    type="submit"
                    size="large"
                    disabled={isLoading}
                >
                    {isLoading ? '⏳ Procesando...' : '🔄 Actualizar Top Ventas'}
                </s-button>
            </fetcher.Form>

            {/* Loading State */}
            {isLoading && (
                <div style={{
                    marginTop: '24px',
                    padding: '20px',
                    background: '#f3f4f6',
                    borderRadius: '8px',
                    textAlign: 'center'
                }}>
                    <div style={{ fontSize: '16px', fontWeight: '500', marginBottom: '12px' }}>
                        ⏳ Procesando órdenes y calculando productos más vendidos...
                    </div>
                    <div style={{
                        width: '100%',
                        height: '4px',
                        background: '#e5e7eb',
                        borderRadius: '2px',
                        overflow: 'hidden'
                    }}>
                        <div style={{
                            width: '30%',
                            height: '100%',
                            background: '#3b82f6',
                            animation: 'progress 1.5s ease-in-out infinite'
                        }} />
                    </div>
                </div>
            )}

            {/* Results */}
            {data && !isLoading && (
                <div style={{ marginTop: '24px' }}>
                    {data.success ? (
                        <>
                            {/* Success Banner */}
                            <div style={{
                                padding: '16px',
                                background: '#d1fae5',
                                border: '1px solid #6ee7b7',
                                borderRadius: '8px',
                                marginBottom: '24px'
                            }}>
                                <div style={{ fontSize: '16px', fontWeight: '600', color: '#065f46', marginBottom: '4px' }}>
                                    ✅ Colección actualizada exitosamente
                                </div>
                                <div style={{ fontSize: '14px', color: '#047857' }}>
                                    La colección Top Ventas ha sido actualizada con los productos más vendidos
                                </div>
                            </div>

                            {/* Stats Grid */}
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                                gap: '16px',
                                marginBottom: '24px'
                            }}>
                                <div style={{
                                    padding: '20px',
                                    background: 'white',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: '8px'
                                }}>
                                    <div style={{ fontSize: '32px', fontWeight: '700', color: '#1f2937', marginBottom: '4px' }}>
                                        {data.ordersCount}
                                    </div>
                                    <div style={{ fontSize: '14px', color: '#6b7280' }}>
                                        📦 Órdenes procesadas
                                    </div>
                                </div>

                                <div style={{
                                    padding: '20px',
                                    background: 'white',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: '8px'
                                }}>
                                    <div style={{ fontSize: '32px', fontWeight: '700', color: '#1f2937', marginBottom: '4px' }}>
                                        {data.productsAdded}
                                    </div>
                                    <div style={{ fontSize: '14px', color: '#6b7280' }}>
                                        🛍️ Productos añadidos
                                    </div>
                                </div>

                                <div style={{
                                    padding: '20px',
                                    background: 'white',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: '8px',
                                    gridColumn: 'span 2'
                                }}>
                                    <div style={{ fontSize: '14px', color: '#6b7280', marginBottom: '4px' }}>
                                        📁 ID de Colección
                                    </div>
                                    <div style={{
                                        fontSize: '14px',
                                        fontFamily: 'monospace',
                                        color: '#1f2937',
                                        wordBreak: 'break-all'
                                    }}>
                                        {data.collectionId}
                                    </div>
                                </div>
                            </div>

                            {/* Top Products List */}
                            {data.topSales && data.topSales.length > 0 ? (
                                <div style={{
                                    background: 'white',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: '8px',
                                    overflow: 'hidden'
                                }}>
                                    <div style={{
                                        padding: '16px',
                                        borderBottom: '1px solid #e5e7eb',
                                        background: '#f9fafb'
                                    }}>
                                        <h2 style={{ fontSize: '18px', fontWeight: '600', margin: 0 }}>
                                            🏆 Top {data.topSales.length} Productos Más Vendidos
                                        </h2>
                                    </div>

                                    <div style={{ padding: '0' }}>
                                        {data.topSales.slice(0, showAllProducts ? data.topSales.length : 10).map((product, index) => (
                                            <div
                                                key={product.productId}
                                                style={{
                                                    padding: '16px',
                                                    borderBottom: index < data.topSales.length - 1 ? '1px solid #f3f4f6' : 'none',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '12px',
                                                    transition: 'background 0.2s',
                                                    ':hover': { background: '#f9fafb' }
                                                }}
                                            >
                                                <div style={{
                                                    width: '32px',
                                                    height: '32px',
                                                    borderRadius: '50%',
                                                    background: index < 3 ? '#fef3c7' : '#f3f4f6',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    fontWeight: '700',
                                                    fontSize: '14px',
                                                    color: index < 3 ? '#92400e' : '#6b7280'
                                                }}>
                                                    {index + 1}
                                                </div>
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontSize: '14px', fontWeight: '500', color: '#1f2937' }}>
                                                        {product.title}
                                                    </div>
                                                    <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '2px' }}>
                                                        ID: {product.productId.split('/').pop()}
                                                    </div>
                                                </div>
                                                <div style={{
                                                    padding: '6px 12px',
                                                    background: '#dbeafe',
                                                    borderRadius: '6px',
                                                    fontSize: '14px',
                                                    fontWeight: '600',
                                                    color: '#1e40af'
                                                }}>
                                                    {product.units} unidades
                                                </div>
                                            </div>
                                        ))}
                                    </div>

                                    {data.topSales.length > 10 && (
                                        <div style={{
                                            padding: '12px 16px',
                                            borderTop: '1px solid #e5e7eb',
                                            background: '#f9fafb',
                                            textAlign: 'center'
                                        }}>
                                            <button
                                                onClick={() => setShowAllProducts(!showAllProducts)}
                                                style={{
                                                    background: 'none',
                                                    border: 'none',
                                                    color: '#3b82f6',
                                                    fontSize: '14px',
                                                    fontWeight: '500',
                                                    cursor: 'pointer',
                                                    padding: '4px 8px'
                                                }}
                                            >
                                                {showAllProducts ? '▲ Mostrar menos' : `▼ Mostrar ${data.topSales.length - 10} más`}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div style={{
                                    padding: '40px',
                                    background: 'white',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: '8px',
                                    textAlign: 'center'
                                }}>
                                    <div style={{ fontSize: '48px', marginBottom: '16px' }}>📊</div>
                                    <div style={{ fontSize: '16px', fontWeight: '500', color: '#6b7280' }}>
                                        No se encontraron productos en las órdenes pagadas
                                    </div>
                                </div>
                            )}
                        </>
                    ) : (
                        /* Error State */
                        <div style={{
                            padding: '16px',
                            background: '#fee2e2',
                            border: '1px solid #fca5a5',
                            borderRadius: '8px'
                        }}>
                            <div style={{ fontSize: '16px', fontWeight: '600', color: '#991b1b', marginBottom: '4px' }}>
                                ❌ Error al actualizar la colección
                            </div>
                            <div style={{ fontSize: '14px', color: '#b91c1c' }}>
                                {data.error || 'Ocurrió un error desconocido'}
                            </div>
                        </div>
                    )}
                </div>
            )}

            <style>{`
                @keyframes progress {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(400%); }
                }
            `}</style>
        </div>
    );
}