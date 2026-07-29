import { ProgressBar } from '@shopify/polaris';
import '@shopify/polaris/build/esm/styles.css';
import jsPDF from 'jspdf';
import { useEffect, useMemo, useState } from 'react';
import { useFetcher } from "react-router";
import Pagination from '../components/Pagination.jsx';
import { authenticate } from "../shopify.server.js";
import styles from "./_index/styles.module.css";

// CSS inline para animaciones
const animationStyles = `
  @keyframes fadeInSlide {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
`;

export const action = async ({ request }) => {
  console.warn('🚨 [ACTION] Action ejecutado - Método:', request.method);

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { session, admin } = await authenticate.admin(request);
    console.info('✅ [ACTION] Autenticación exitosa');

    const formData = await request.formData();
    const xmlUrl = formData.get("xmlUrl");

    if (!xmlUrl) {
      return Response.json({ error: "URL del XML es requerida" }, { status: 400 });
    }

    // Usar parseXMLData para obtener estadísticas de variantes y estructuración completa
    const { syncXmlString } = await import("../services/xml-sync.server.js");
    let finalProducts = [];

    // Solo parsear (sin admin = solo parsing y estadísticas, no creación en Shopify)
    syncXmlString(admin, xmlUrl)
      .then(parsedProducts => {
        if (!parsedProducts || parsedProducts.length === 0) {
          return Response.json({ error: "No se encontraron productos en el XML" }, { status: 400 });
        }

        finalProducts = parsedProducts;
      });

    const shopDomain = session.shop.replace('.myshopify.com', '');

    // Devolver productos parseados al cliente
    return Response.json({
      success: true,
      totalProducts: finalProducts.length,
      products: finalProducts, // ← Los productos van al cliente
      message: 'XML parseado exitosamente',
      shopDomain,
      parsedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [ACTION] Error:', error);
    return Response.json({
      error: error.message || "Error parseando XML",
      success: false
    }, { status: 500 });
  }
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const shopDomain = session.shop.replace('.myshopify.com', '');

  return Response.json({
    shop: shopDomain,
    sessionId: session.id
  });
};

// Nombres legibles para los campos que devuelve computeProductUpdate. Sin esto
// la UI muestra el identificador del código ("descriptionHtml", "productOptions"),
// que no significa nada para quien gestiona la tienda.
const ETIQUETAS_CAMPO = {
  title:           "Título",
  vendor:          "Marca",
  descriptionHtml: "Descripción",
  tags:            "Etiquetas",
  productOptions:  "Opciones",
};

const etiquetarCampos = (campos = []) =>
  campos.map(c => ETIQUETAS_CAMPO[c] || c);

export default function Index() {
  const fetcher = useFetcher();
  const [syncState, setSyncState] = useState(null); // Estado unificado

  const [groupStatus, setGroupStatus] = useState([]);
  const [variantStatusByGroup, setVariantStatusByGroup] = useState({});
  const [productsWithSmallImages, setProductsWithSmallImages] = useState([]);
  // Estado de la reconciliación final de huérfanos (productos con tag
  // "cosladafon" cuyo modelo ya no aparece en el feed y se eliminan).
  const [reconcileStatus, setReconcileStatus] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);

  // Envía la señal de cancelación al backend sin borrar los datos mostrados.
  // El estado se limpia al inicio de una nueva sincronización (sync-start).
  const cancelSync = async () => {
    try {
      await fetch("/api/sync-cancel");
      console.log("🔴 Cancelación solicitada al backend");
    } catch (e) {
      console.warn("No se pudo notificar la cancelación al backend", e);
    }
  };

  const [smallImagesListPage, setSmallImagesListPage] = useState(1);
  const [loadingSmallImagesPdf, setLoadingSmallImagesPdf] = useState(false);
  const smallPageSize = 10;

  const smallTotalPages = useMemo(
    () => Math.ceil(productsWithSmallImages.length / smallPageSize),
    [productsWithSmallImages, smallPageSize]
  );

  const smallPaginated = useMemo(() => {
    const start = (smallImagesListPage - 1) * smallPageSize;
    const end = start + smallPageSize;
    return productsWithSmallImages.slice(start, end);
  }, [productsWithSmallImages, smallImagesListPage, smallPageSize]);


  async function loadImageAsDataURL(url) {
    try {
      // Usar el proxy del servidor para evitar CORS
      const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(url)}`;
      const response = await fetch(proxyUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.success || !data.dataUrl) {
        throw new Error('Invalid response from proxy');
      }

      return data.dataUrl;
    } catch (err) {
      console.warn('No se pudo cargar imagen:', url, err.message);
      return null;
    }
  }

  async function handleExportSmallImagesPdf() {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 40;
    const lineHeight = 16;
    const maxWidth = 515;
    const thumbSize = 60; // tamaño thumbnail
    let y = margin;

    // Título
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Productos con imágenes pequeñas (<600x600)', margin, y);
    y += 24;

    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(11);

    setLoadingSmallImagesPdf(true);

    for (const item of productsWithSmallImages) {
      // Salto de página si no hay espacio
      if (y > 750) {
        doc.addPage();
        y = margin;
      }

      const startY = y;

      // Cargar y añadir thumbnail
      if (item.image) {
        try {
          const img = await loadImageAsDataURL(item.image);
          doc.addImage(img, 'JPEG', margin, y, thumbSize, thumbSize);
        } catch (err) {
          console.warn('No se pudo cargar imagen:', item.image, err);
        }
      }

      // Texto al lado del thumbnail
      const textX = margin + thumbSize + 12;
      const textWidth = maxWidth - thumbSize - 12;

      const rows = [
        `Producto: ${item.productName || ''}`,
        `Id: ${item.sku || ''}`,
        `${item.capacity || ''} • ${item.color || ''} • ${item.condition || ''}`,
        `Dimensiones: ${item?.dimensions ? `${item.dimensions.width}x${item.dimensions.height}px` : 'N/D'}`,
        `URL: ${item.image || ''}`
      ];

      let textY = y + lineHeight;
      rows.forEach((row) => {
        const split = doc.splitTextToSize(row, textWidth);
        doc.text(split, textX, textY);
        textY += lineHeight * (Array.isArray(split) ? split.length : 1);
      });

      // Avanzar Y al máximo entre thumbnail y texto
      y = Math.max(startY + thumbSize, textY) + 10;

      // Separador
      doc.setDrawColor(200);
      doc.line(margin, y, margin + maxWidth, y);
      y += 14;
    }

    setLoadingSmallImagesPdf(false);

    doc.save('imagenes-pequenas.pdf');
  }

  const actionData = fetcher.data;
  const isLoading = fetcher.state === "submitting";
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const totalPages = Math.ceil(groupStatus.filter(g => g.status !== "pending").length / pageSize);
  const paginated = groupStatus
    .sort((a, b) => {
      const order = {
        processing: 0,
        error: 1,
        pending: 2,
        success: 3,
      };

      return order[a.status] - order[b.status];
    })
    .filter(g => g.status !== "pending").slice((page - 1) * pageSize, page * pageSize);

  const groupStatusTotals = useMemo(() => {
    let created = 0, updated = 0, skipped = 0, errors = 0, deleted = 0;

    for (const g of groupStatus) {
      created += g.created || 0;
      updated += g.updated || 0;
      skipped += g.skipped || 0;
      errors += g.errors || 0;
      deleted += g.deleted || 0;
    }

    return {
      created,
      updated,
      skipped,
      errors,
      deleted,
      totalProcessedProducts: created + updated + skipped + errors
    };
  }, [groupStatus])

  // Grupo actualmente en proceso y progreso de sus variantes
  const currentGroup = groupStatus.find(g => g.status === "processing") || null;
  const groupsDone = groupStatus.filter(g => !["pending", "processing"].includes(g.status)).length;
  const totalGroups = groupStatus.length;

  const currentGroupVariantEntries = Object.values(
    currentGroup ? (variantStatusByGroup[currentGroup.id] || {}) : {}
  );
  const currentGroupProcessed = currentGroupVariantEntries.filter(v =>
    ["success", "error", "deleted"].includes(v.status)
  ).length;
  const currentGroupTotal = currentGroup?.totalVariants || currentGroupVariantEntries.length || 1;

  useEffect(() => {
    const es = new EventSource("/api/sync-events");

    setSyncState({
      isActive: true,
      status: "stopped",
      totalItems: 0,
      processedItems: 0,
      createdItems: 0,
      updatedItems: 0,
      skippedItems: 0,
      errorItems: 0,
      recentProducts: [],
      currentStep: "Esperando eventos…"
    });

    es.addEventListener("connected", () => {
      setSyncState(prev => ({
        ...prev,
        currentStep: "Conectado al servidor"
      }));
    });

    es.addEventListener("sync-start", e => {
      const d = JSON.parse(e.data);

      // Limpiar datos de la sync anterior al arrancar una nueva
      setGroupStatus([]);
      setVariantStatusByGroup({});
      setProductsWithSmallImages([]);
      setReconcileStatus(null);
      setAiStatus(null);

      setSyncState(prev => ({
        ...prev,
        status: "syncing",
        totalItems: d.totalProducts || 0,
        currentStep: "Sincronización iniciada"
      }));
    });

    es.addEventListener("groups_list", (e) => {
      const d = JSON.parse(e.data);


      setGroupStatus(
        d.groups.map(g => ({
          id: g,
          name: g,
          status: 'pending',
          error: null,
        })
        ));

      setSyncState(prev => ({
        ...prev,
        currentStep: `Detectados ${d.groups.length} grupos`
      }));
    });

    es.addEventListener("groups-detected", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Detectados ${Object.keys(d.groups).length} grupos`
      }));
    });

    es.addEventListener("group_start", e => {
      const d = JSON.parse(e.data);

      setGroupStatus(prev => {
        return prev.map(g =>
          g.id === d.id ? {
            ...d,
            status: "processing",
            created: 0,
            updated: 0,
            skipped: 0,
            errors: 0,
            deleted: 0,
            productChangedFields: [],
            productNoChanges: false
          } : g
        )
      });

      setSyncState(prev => ({
        ...prev,
        currentStep: `Iniciando grupo ${d.id}`
      }));
    });

    es.addEventListener('group_unchanged', e => {
      const d = JSON.parse(e.data);


      setGroupStatus(prev => prev.map(g =>
        g.id === d.id
          ? { ...g, status: "unchanged" }
          : g
      )
      );
    })

    es.addEventListener("group_end", e => {
      const d = JSON.parse(e.data);


      setGroupStatus(prev => {
        return prev.map(g =>
          g.id === d.id ? { ...g, status: "success" } : g
        )
      });
    });

    es.addEventListener("group_error", e => {
      const d = JSON.parse(e.data);

      console.log("❌ [EVENT] group_error:", d);
      setGroupStatus(prev =>
        prev.map(g =>
          g.id === d.id ? { ...g, status: "error", error: d.error } : g
        )
      );

      setSyncState(prev => ({
        ...prev,
        currentStep: `Error en grupo ${d.id}`,
        errorItems: prev.errorItems + 1
      }));
    });

    es.addEventListener("product_created", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Producto creado: ${d.product?.title || d.groupId}`,
        recentProducts: [
          { type: "created", title: d.product?.title, sku: null },
          ...((prev.recentProducts || []).slice(0, 9))
        ]
      }));
    });

    es.addEventListener("product_create_request", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Creando producto: ${d.title}`,
        recentProducts: [
          { type: "request", title: d.title, groupId: d.groupId },
          ...prev.recentProducts.slice(0, 9)
        ]
      }));
    });

    es.addEventListener("product_updated", e => {
      const d = JSON.parse(e.data);
      const changed = Array.isArray(d.changedFields) ? d.changedFields : [];
      const fieldsText = changed.length ? etiquetarCampos(changed).join(", ") : "sin cambios";
      const stepText = d.noChanges
        ? `Producto sin cambios: ${d.groupId || d.productId}`
        : `Producto actualizado (${fieldsText}): ${d.groupId || d.productId}`;

      setSyncState(prev => ({
        ...prev,
        currentStep: stepText,
        recentProducts: [
          {
            type: "product_updated",
            title: d.groupId || d.productId,
            productId: d.productId,
            changedFields: changed,
            noChanges: !!d.noChanges
          },
          ...prev.recentProducts.slice(0, 9)
        ]
      }));

      if (d.groupId) {
        setGroupStatus(prev =>
          prev.map(g =>
            g.id === d.groupId
              ? {
                ...g,
                productChangedFields: changed,
                productNoChanges: !!d.noChanges
              }
              : g
          )
        );
      }
    });

    es.addEventListener("product_update_error", e => {
      const d = JSON.parse(e.data);
      const changed = Array.isArray(d.changedFields) ? d.changedFields : [];
      const fieldsText = changed.length ? ` (${changed.join(", ")})` : "";

      setSyncState(prev => ({
        ...prev,
        currentStep: `Error actualizando producto${fieldsText}: ${d.groupId || d.productId}`,
        errorItems: prev.errorItems + 1,
        recentProducts: [
          {
            type: "product_update_error",
            title: d.groupId || d.productId,
            productId: d.productId,
            changedFields: changed,
            message: d?.errors?.[0]?.message || "Error actualizando producto"
          },
          ...prev.recentProducts.slice(0, 9)
        ]
      }));

      if (d.groupId) {
        setGroupStatus(prev =>
          prev.map(g =>
            g.id === d.groupId
              ? {
                ...g,
                status: "error",
                error: d?.errors?.[0]?.message || "Error actualizando producto",
                productChangedFields: changed,
                productNoChanges: false
              }
              : g
          )
        );
      }
    });

    es.addEventListener("product_media_uploaded", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Imágenes subidas (${d.count}) para producto ${d.productId}`
      }));
    });

    es.addEventListener("product_media_added", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        currentStep: `Imágenes añadidas al producto ${d.productId}`
      }));
    });

    es.addEventListener("product_synced", e => {
      const d = JSON.parse(e.data);

      setSyncState(prev => ({
        ...prev,
        processedItems: prev.processedItems + 1,
        createdItems: prev.createdItems + (d.createdVariants || 0),
        updatedItems: prev.updatedItems + (d.updatedVariants || 0),
        currentStep: `Producto sincronizado (${d.createdVariants} creadas / ${d.updatedVariants} actualizadas)`,
        recentProducts: [
          {
            type: "updated",
            title: d.groupId,
            created: d.createdVariants,
            updated: d.updatedVariants
          },
          ...prev.recentProducts.slice(0, 9)
        ]
      }));
    });

    es.addEventListener("variant_create_detected", e => {
      const d = JSON.parse(e.data);

      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...(prev[d.groupId] || {}),
          [d.variant.sku]: {
            status: "detected_create",
            variant: d.variant
          }
        }
      }));
    });

    es.addEventListener("variant_update_detected", e => {
      const d = JSON.parse(e.data);


      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...(prev[d.groupId] || {}),
          [d.variant.sku]: {
            status: "detected_update",
            variant: d.variant
          }
        }
      }));
    });

    es.addEventListener("variant_processing_start", e => {
      const d = JSON.parse(e.data);


      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...prev[d.groupId],
          [d.variant.sku]: {
            status: "processing",
            variant: d.variant
          }
        }
      }));
    });

    es.addEventListener("variant_image_too_small", e => {
      const d = JSON.parse(e.data);

      console.log({ ...d })

      setProductsWithSmallImages(prev => {
        // Evitar duplicados por groupId
        const exists = prev.find(item => item.groupId === d.groupId && item.sku === d.variant.sku);
        if (exists) return prev;

        console.log([...prev, {
          groupId: d.groupId,
          productName: d.groupId, // o puedes enviar el título desde el servidor
          sku: d.variant.sku,
          image: d.variant.image,
          dimensions: d.variant.imageDimensions,
          capacity: d.variant.capacity,
          color: d.variant.color,
          condition: d.variant.condition
        }])

        return [...prev, {
          groupId: d.groupId,
          productName: d.groupId, // o puedes enviar el título desde el servidor
          sku: d.variant.sku,
          image: d.variant.image,
          dimensions: d.variant.imageDimensions,
          capacity: d.variant.capacity,
          color: d.variant.color,
          condition: d.variant.condition
        }];
      });

      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...prev[d.groupId],
          [d.variant.sku]: {
            status: "error",
            message: "La imagen es demasiado pequeña",
            variant: d.variant
          }
        }
      }));
    })

    es.addEventListener("variant_processing_success", e => {
      const d = JSON.parse(e.data);

      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...prev[d.groupId],
          [d.variant.sku]: {
            status: "success",
            action: d.action,
            variant: d.variant
          }
        }
      }));

      setGroupStatus(prev =>
        prev.map(g => g.id === d.groupId ? {
          ...g,
          created: g.created + (d.action === "created" ? 1 : 0),
          updated: g.updated + (d.action === "updated" ? 1 : 0),
          skipped: g.skipped + (d.action === "skipped" ? 1 : 0)
        }
          : g
        )
      )
    });

    es.addEventListener("variant_processing_error", e => {
      const d = JSON.parse(e.data);

      setVariantStatusByGroup(prev => ({
        ...prev,
        [d.groupId]: {
          ...(prev[d.groupId] || {}),
          [d.variant?.sku || `error-${Date.now()}`]: {
            status: "error",
            message: d.message
          }
        }
      }));

      setGroupStatus(prev =>
        prev.map(g =>
          g.id === d.groupId ? {
            ...g,
            status: 'error',
            errors: g.errors + 1
          }
            : g
        )
      )
    });

    es.addEventListener("variants_purged", e => {
      const d = JSON.parse(e.data);

      // Registrar cada variante eliminada en variantStatusByGroup
      setVariantStatusByGroup(prev => {
        const groupVariants = { ...(prev[d.groupId] || {}) };
        for (const v of (d.variants || [])) {
          const key = v.sku || v.id;
          const capacity = v.options?.find(o => o.name?.toLowerCase() === 'capacidad')?.value || '';
          const color = v.options?.find(o => o.name?.toLowerCase() === 'color')?.value || '';
          const condition = v.options?.find(o => o.name?.toLowerCase() === 'condición')?.value || '';
          groupVariants[key] = {
            status: "deleted",
            action: "deleted",
            variant: { sku: v.sku, capacity, color, condition }
          };
        }
        return { ...prev, [d.groupId]: groupVariants };
      });

      // Actualizar el contador de eliminadas en el grupo
      setGroupStatus(prev =>
        prev.map(g =>
          g.id === d.groupId
            ? { ...g, deleted: (g.deleted || 0) + (d.variants?.length || 0) }
            : g
        )
      );
    });

    // ── RECONCILIACIÓN DE HUÉRFANOS ────────────────────────────────────────
    // Fase final: se eliminan los productos con tag "cosladafon" cuyo modelo
    // ya no aparece en el feed. Estos eventos alimentan el panel de resumen.
    es.addEventListener("reconcile-start", () => {
      setReconcileStatus({
        phase: "running",
        managed: 0,
        synced: 0,
        orphans: [],
        deleted: [],
        errors: [],
      });
    });

    es.addEventListener("reconcile-detected", e => {
      const d = JSON.parse(e.data);
      setReconcileStatus(prev => ({
        ...(prev || { deleted: [], errors: [] }),
        phase: "running",
        managed: d.managed || 0,
        synced: d.synced || 0,
        orphans: d.orphans || [],
      }));
    });

    es.addEventListener("reconcile-product-deleted", e => {
      const d = JSON.parse(e.data);
      setReconcileStatus(prev => ({
        ...(prev || { orphans: [], errors: [] }),
        phase: "running",
        deleted: [...(prev?.deleted || []), { id: d.productId, title: d.title }],
      }));
    });

    es.addEventListener("reconcile-product-error", e => {
      const d = JSON.parse(e.data);
      setReconcileStatus(prev => ({
        ...(prev || { orphans: [], deleted: [] }),
        phase: "running",
        errors: [...(prev?.errors || []), { id: d.productId, title: d.title, message: d.errors?.[0]?.message || "Error" }],
      }));
    });

    es.addEventListener("reconcile-end", e => {
      const d = JSON.parse(e.data);
      setReconcileStatus(prev => ({
        ...(prev || { orphans: [], deleted: [], errors: [] }),
        phase: "done",
        totalDeleted: d.deleted || 0,
      }));
    });

    es.addEventListener("reconcile-skipped", e => {
      const d = JSON.parse(e.data);
      setReconcileStatus({
        phase: "skipped",
        reason: d.reason,
        managed: 0,
        synced: 0,
        orphans: [],
        deleted: [],
        errors: [],
      });
    });

    es.addEventListener("reconcile-error", e => {
      const d = JSON.parse(e.data);
      setReconcileStatus(prev => ({
        ...(prev || { orphans: [], deleted: [] }),
        phase: "error",
        errors: [...(prev?.errors || []), { message: d.error || "Error listando productos" }],
      }));
    });

    es.addEventListener("ai-identity", e => {
      const d = JSON.parse(e.data);
      setAiStatus(prev => ({ ...(prev || {}), identidad: d }));
    });

    es.addEventListener("ai-resolve-start", e => {
      const d = JSON.parse(e.data);
      setAiStatus(prev => ({ ...(prev || {}), modelos: { enCurso: true, total: d.total || 0 } }));
    });

    es.addEventListener("ai-resolve-progress", e => {
      const d = JSON.parse(e.data);
      setAiStatus(prev => ({
        ...(prev || {}),
        modelos: { ...(prev?.modelos || {}), enCurso: true, lote: d.lote, totalLotes: d.totalLotes },
      }));
    });

    es.addEventListener("ai-resolve-end", e => {
      const d = JSON.parse(e.data);
      setAiStatus(prev => ({ ...(prev || {}), modelos: { ...d, enCurso: false } }));
    });

    // Las descripciones llegan de una en una desde processGroup, así que aquí
    // se acumulan. setAiStatus(null) en "sync-start" evita que los contadores
    // se arrastren entre sincronizaciones sucesivas.
    es.addEventListener("ai-description", e => {
      const d = JSON.parse(e.data);
      setAiStatus(prev => {
        const c = prev?.descripciones || { desdeCache: 0, generadas: 0, fallidas: 0, omitidas: 0 };
        return {
          ...(prev || {}),
          descripciones: {
            desdeCache: c.desdeCache + (d.estado === "cache" ? 1 : 0),
            generadas:  c.generadas  + (d.estado === "generada" ? 1 : 0),
            fallidas:   c.fallidas   + (d.estado === "fallida" ? 1 : 0),
            omitidas:   c.omitidas   + (d.estado === "omitida" ? 1 : 0),
            motivo:     d.estado === "omitida" ? d.motivo : c.motivo,
            generando:  d.estado === "generando" ? d.modelTitle : null,
          },
        };
      });
    });

    es.addEventListener("sync-end", () => {
      setSyncState(prev => ({
        ...prev,
        isActive: false,
        status: "sync-completed",
        currentStep: "Sincronización completada"
      }));
    });

    es.addEventListener("sync-cancelled", e => {
      const d = JSON.parse(e.data);


      setSyncState(prev => ({
        ...prev,
        isActive: false,
        status: "cancelled",
        currentStep: d.message || "Sincronización cancelada por el usuario"
      }));
    });

    return () => es.close();
  }, []);

  useEffect(() => {
    console.log("📊 [STATE] variantStatusByGroup actualizado:", variantStatusByGroup);
  }, [variantStatusByGroup]);

  // ✨ NUEVO: useEffect que inicia procesamiento cuando recibimos productos del action
  useEffect(() => {
    if (!actionData?.success || !actionData?.products) return;

    // Llamar al endpoint de procesamiento
    const startProcessing = async () => {
      try {
        await fetch('/api/process-products', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            products: actionData.products,
            shopDomain: actionData.shopDomain
          })
        });

      } catch (error) {
        console.error('❌ [CLIENT] Error llamando procesamiento:', error);
      }
    };

    startProcessing();

  }, [actionData]); // ← Se ejecuta cuando actionData cambia


  return (
    <div className={styles.xmlApp}>
      <style dangerouslySetInnerHTML={{ __html: animationStyles }} />

      <s-page heading="Importar Productos desde XML" inlineSize='large'>

        {/* SECCIÓN PRINCIPAL DE IMPORTACIÓN */}
        <s-section>
          <s-card>
            <s-stack gap="base">
              <s-stack gap="base" horizontal alignment="space-between">
                <s-text variant="heading-md">
                  📦 Importar Productos desde XML
                </s-text>
              </s-stack>

              <s-text variant="body-md" tone="subdued">
                Importa productos desde un feed XML de Google Shopping con procesamiento optimizado en tiempo real.
                ⚡ <strong>Hasta 6 productos simultáneos</strong> con cache inteligente y rate limiting.
              </s-text>

              <fetcher.Form method="post">
                <s-stack gap="base">
                  <s-text-field
                    label="URL del XML"
                    name="xmlUrl"
                    type="url"
                    placeholder="https://ejemplo.com/feed.xml"
                    required
                    details="URL del feed XML con los productos de Google Shopping"
                    disabled={syncState?.status === 'syncing'}
                  />

                  <s-stack direction="inline" columnGap="large">
                    <s-button
                      variant="primary"
                      type="submit"
                      loading={isLoading}
                      disabled={isLoading || syncState?.status === 'syncing'}
                      size="large"
                    >
                      {isLoading ? "🔍 Analizando XML..." :
                        syncState?.status === 'syncing' ? "🚀 Procesando..." :
                          "📥 Importar Productos"}
                    </s-button>
                    {import.meta.env.MODE === 'development' && (
                      <s-button
                        variant="secondary"
                        size="large"
                        onClick={async () => {
                          const result = await fetch("/api/get-colors", { method: "POST" });
                          const data = await result.json();
                          // console.log("🎨 COLORES OBTENIDOS:", data.colors);
                          alert("Colores obtenidos. Mira la consola.");
                        }}
                      >
                        🎨 Obtener colores existentes
                      </s-button>
                    )}
                    {import.meta.env.MODE === 'development' && (
                      <s-button
                        variant="secondary"
                        size="large"
                        type="button"
                        onClick={async () => {
                          const xmlUrl = prompt("URL del feed XML:");
                          if (!xmlUrl) return;

                          const apply = confirm(
                            "¿APLICAR los cambios?\n\n" +
                            "Aceptar = escribe en la base de datos\n" +
                            "Cancelar = solo simula (recomendado la primera vez)"
                          );

                          const res = await fetch("/api/seed-model-cache", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ xmlUrl, apply })
                          });
                          const data = await res.json();
                          console.log("🌱 SEED MODEL CACHE:", data);
                          console.table(data.modelosFragmentados || []);
                          console.table(data.productosVivosSinTituloEnFeed || []);
                          alert(
                            `${data.dryRun ? "SIMULACIÓN" : "APLICADO"}\n\n` +
                            `Productos vivos en Shopify: ${data.productosVivosEnShopify}\n` +
                            `Títulos distintos en feed: ${data.titulosDistintosEnFeed}\n` +
                            `Títulos a congelar: ${data.titulosACongelar}\n` +
                            `Escritos: ${data.escritos}\n\n` +
                            `Detalle completo en la consola.`
                          );
                        }}
                      >
                        🌱 Sembrar caché de modelos
                      </s-button>
                    )}
                    {syncState?.status === 'syncing' && (
                      <s-button
                        variant="secondary"
                        size="large"
                        onClick={cancelSync}
                      >
                        🛑 Cancelar importación
                      </s-button>
                    )}
                  </s-stack>
                </s-stack>
              </fetcher.Form>
            </s-stack>
          </s-card>
        </s-section>

        {/* SECCIÓN DE PROGRESO EN TIEMPO REAL */}
        {groupStatus.length > 0 && (
          <s-section>
            <s-stack rowGap="large-100">
              <s-stack rowGap="large-100">
                <s-stack direction="inline" columnGap="large">
                  <s-text variant="heading-sm" fontWeight="semibold">
                    🚀 Procesamiento en Tiempo Real
                  </s-text>
                  <s-badge
                    tone={syncState?.status === 'sync-completed' ? 'success' : syncState?.status === 'cancelled' ? 'warning' : 'info'}
                    size="small"
                  >
                    {syncState?.status === 'sync-completed' ? '🎉 Completado' : syncState?.status === 'cancelled' ? '🛑 Cancelado' : '⚡ En Progreso'}
                  </s-badge>
                </s-stack>

                {/* BARRA DE PROGRESO VISUAL */}
                <s-stack rowGap="base">
                  {/* Barra 1: progreso de grupos */}
                  <s-stack rowGap="tight">
                    <s-stack direction="inline" alignContent="space-between" justifyContent='space-between' blockSize="auto">
                      <s-text variant="body-sm" fontWeight="medium">
                        Grupos: {groupsDone} / {totalGroups}
                      </s-text>
                      <s-text variant="caption" tone="subdued">
                        {totalGroups > 0 ? Math.round((groupsDone / totalGroups) * 100) : 0}%
                      </s-text>
                    </s-stack>
                    <ProgressBar
                      progress={totalGroups > 0 ? (groupsDone / totalGroups) * 100 : 0}
                      size="small"
                    />
                  </s-stack>

                  {/* Barra 2: variantes del grupo en proceso */}
                  {currentGroup && (
                    <s-stack rowGap="tight">
                      <s-stack direction="inline" alignContent="space-between" justifyContent='space-between' blockSize="auto">
                        <s-text variant="body-sm" fontWeight="medium">
                          Variantes de <em>{currentGroup.name || currentGroup.id}</em>: {currentGroupProcessed} / {currentGroupTotal}
                        </s-text>
                        <s-text variant="caption" tone="subdued">
                          {Math.round((currentGroupProcessed / currentGroupTotal) * 100)}%
                        </s-text>
                      </s-stack>
                      <ProgressBar
                        progress={(currentGroupProcessed / currentGroupTotal) * 100}
                        size="small"
                      />
                    </s-stack>
                  )}
                </s-stack>
              </s-stack>

              {/* ESTADÍSTICAS EN TIEMPO REAL */}
              <s-stack gap="base" horizontal>
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(100px, 1fr))" gap="base">
                  {/* PRODUCTOS NUEVOS */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text accessibilityRole="" fontWeight="bold" tone="success" >
                        {groupStatusTotals.created}
                      </s-text>
                      <s-badge tone="success" size="small">
                        🆕 Creados
                      </s-badge>
                    </s-stack>
                  </s-box>

                  {/* PRODUCTOS ACTUALIZADOS */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text variant="heading-lg" fontWeight="bold" tone="info">
                        {groupStatusTotals.updated}
                      </s-text>
                      <s-badge tone="info" size="small">
                        🔄 Actualizados
                      </s-badge>
                    </s-stack>
                  </s-box>

                  {/* PRODUCTOS OMITIDOS */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text variant="heading-lg" fontWeight="bold" tone="warning">
                        {groupStatusTotals.skipped}
                      </s-text>
                      <s-badge tone="warning" size="small">
                        ⏭️ Omitidos
                      </s-badge>
                    </s-stack>
                  </s-box>

                  {/* ELIMINADAS */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text variant="heading-lg" fontWeight="bold" tone="critical">
                        {groupStatusTotals.deleted}
                      </s-text>
                      <s-badge tone="critical" size="small">
                        🗑️ Eliminadas
                      </s-badge>
                    </s-stack>
                  </s-box>

                  {/* ERRORES */}
                  <s-box background="subdued" border="base" borderRadius="base" borderColor="base" padding="large">
                    <s-stack rowGap="large" justifyContent="center" alignItems="center">
                      <s-text variant="heading-lg" fontWeight="bold" tone="critical">
                        {groupStatusTotals.errors}
                      </s-text>
                      <s-badge tone="critical" size="small">
                        ❌ Errores
                      </s-badge>
                    </s-stack>
                  </s-box>
                </s-grid>
              </s-stack>
            </s-stack>
          </s-section>
        )}

        {/* RESUMEN DE PRODUCTOS CON IMÁGENES PEQUEÑAS */}
        {productsWithSmallImages.length > 0 && (
          <s-section>
            <s-card>
              <s-banner tone="warning">
                <s-stack gap="base">
                  <s-stack direction="inline" alignment="space-between">
                    <s-text variant="heading-sm" fontWeight="semibold">
                      ⚠️ Productos con imágenes pequeñas ({productsWithSmallImages.length})
                    </s-text>
                  </s-stack>

                  <s-button
                    variant="secondary"
                    size="small"
                    onClick={handleExportSmallImagesPdf}
                    loading={loadingSmallImagesPdf}
                    disabled={loadingSmallImagesPdf}
                  >
                    📄 Exportar PDF
                  </s-button>

                  <s-text variant="body-sm" tone="subdued">
                    Los siguientes productos tienen imágenes menores a 600x600 píxeles:
                  </s-text>

                  <s-stack gap="small">
                    {smallPaginated.map((item, idx) => (
                      <s-box key={`${item.sku}-${idx}`} padding="base" background="subdued" borderRadius="base">
                        <s-stack direction="inline" alignment="start" gap="base">
                          {item.image && (
                            <s-box blockSize="60px" inlineSize="60px" style={{ flex: '0 0 60px' }}>
                              <s-image src={item.image} alt={item.productName} inlineSize="fill" />
                            </s-box>
                          )}

                          <s-stack gap="tight" style={{ flex: 1 }}>
                            <s-text variant="body-md" fontWeight="semibold">
                              {item.productName}
                            </s-text>
                            <s-text variant="body-sm" tone="subdued">
                              {item.capacity} • {item.color} • {item.condition}
                            </s-text>
                            <s-text variant="caption" tone="subdued">
                              SKU: {item.sku}
                            </s-text>
                            {item.dimensions && (
                              <s-badge tone="warning" size="small">
                                📏 {item.dimensions.width}x{item.dimensions.height}px
                              </s-badge>
                            )}
                          </s-stack>
                        </s-stack>
                      </s-box>
                    ))}

                    {/* Paginación con el mismo componente */}
                    <Pagination
                      page={smallImagesListPage}
                      totalPages={smallTotalPages}
                      totalItems={productsWithSmallImages.length}
                      pageSize={smallPageSize}
                      onChange={newPage => setSmallImagesListPage(newPage)}
                    />
                  </s-stack>
                </s-stack>
              </s-banner>
            </s-card>
          </s-section>
        )}

        {/* MENSAJE DE ÉXITO FINAL */}
        {syncState?.status === 'sync-completed' && (
          <s-section>
            <s-card>
              <s-banner tone="success">
                <s-stack gap="tight">
                  <s-text variant="body-md" fontWeight="semibold">
                    ✅ Productos importados exitosamente
                  </s-text>
                  <s-text variant="body-sm">
                    📦 {groupStatusTotals.totalProcessedProducts} productos importados
                  </s-text>
                </s-stack>
              </s-banner>
            </s-card>
          </s-section>
        )}

        {/* MENSAJE DE CANCELACIÓN O ERROR */}
        {syncState?.status === "cancelled" ? (
          <s-section>
            <s-card>
              <s-banner tone="warning">
                <s-stack gap="tight">
                  <s-text variant="body-md" fontWeight="semibold">
                    🛑 Importación cancelada por el usuario
                  </s-text>
                  <s-text variant="body-sm" tone="subdued">
                    Puedes iniciar una nueva importación cuando lo desees.
                  </s-text>
                </s-stack>
              </s-banner>
            </s-card>
          </s-section>
        ) : actionData?.error && (
          <s-section>
            <s-card>
              <s-banner tone="critical">
                <s-stack gap="tight">
                  <s-text variant="body-md" fontWeight="semibold">
                    ❌ Error procesando XML
                  </s-text>
                  <s-text variant="body-sm">
                    {actionData.error}
                  </s-text>
                </s-stack>
              </s-banner>
            </s-card>
          </s-section>
        )}

        {aiStatus && (
          <s-section>
            <s-card padding="base">
              <s-stack gap="base">
                <s-text variant="heading-sm" fontWeight="semibold">🤖 Procesamiento con IA</s-text>

                {aiStatus.identidad && (
                  <s-text variant="body-sm" tone="subdued">
                    🔒 Identidad protegida: {aiStatus.identidad.productosVivos} productos publicados ·
                    {" "}{aiStatus.identidad.congeladosAhora} títulos congelados en esta sync ·
                    {" "}{aiStatus.identidad.yaEnCache} ya en caché
                  </s-text>
                )}

                {aiStatus.modelos?.enCurso && (
                  <s-stack direction="inline" alignment="center" gap="100">
                    <s-spinner size="small" />
                    <s-text variant="caption" tone="subdued">
                      Resolviendo modelos
                      {aiStatus.modelos.totalLotes
                        ? ` — lote ${aiStatus.modelos.lote}/${aiStatus.modelos.totalLotes}`
                        : ` (${aiStatus.modelos.total} títulos)`}…
                    </s-text>
                  </s-stack>
                )}

                {aiStatus.modelos && !aiStatus.modelos.enCurso && (
                  <s-text variant="body-sm" tone="subdued">
                    🔤 Modelos: {aiStatus.modelos.desdeCache} de caché ·
                    {" "}{aiStatus.modelos.resueltos} nuevos ·
                    {" "}{aiStatus.modelos.descartados} descartados
                    {aiStatus.modelos.discrepan > 0 && ` · ${aiStatus.modelos.discrepan} discrepan del extractor`}
                  </s-text>
                )}

                {aiStatus.descripciones?.generando && (
                  <s-stack direction="inline" alignment="center" gap="100">
                    <s-spinner size="small" />
                    <s-text variant="caption" tone="subdued">
                      Escribiendo descripción de {aiStatus.descripciones.generando}…
                    </s-text>
                  </s-stack>
                )}

                {aiStatus.descripciones && (
                  <s-text variant="body-sm" tone="subdued">
                    📝 Descripciones: {aiStatus.descripciones.desdeCache} de caché ·
                    {" "}{aiStatus.descripciones.generadas} generadas
                    {aiStatus.descripciones.fallidas > 0 && ` · ${aiStatus.descripciones.fallidas} fallidas`}
                    {aiStatus.descripciones.omitidas > 0 &&
                      ` · ${aiStatus.descripciones.omitidas} omitidas (${aiStatus.descripciones.motivo})`}
                  </s-text>
                )}

                {/* Se separa por acción requerida: solo los fragmentos que ya
                    tienen producto publicado obligan a intervenir a mano. El
                    resto los resuelve la IA al crearlos y son informativos. */}
                {aiStatus.identidad?.fragmentaciones?.length > 0 && (() => {
                  const requierenAccion = aiStatus.identidad.fragmentaciones.filter(f => f.fragmentoVivo);
                  const seCorrigenSolos = aiStatus.identidad.fragmentaciones.filter(f => !f.fragmentoVivo);

                  return (
                    <s-stack gap="200">
                      {requierenAccion.length > 0 && (
                        <s-banner tone="warning">
                          <s-stack gap="200">
                            <s-text variant="body-sm">
                              ⚠️ {requierenAccion.length} producto(s) publicados están duplicados por un
                              nombre mal extraído del feed. Hay que fusionarlos a mano en Shopify: mueve
                              las variantes al producto correcto y borra el sobrante.
                            </s-text>
                            {requierenAccion.map((f, i) => (
                              <s-text key={i} variant="caption">
                                🔴 <strong>{f.fragmento}</strong> debería ser <strong>{f.base}</strong>
                              </s-text>
                            ))}
                          </s-stack>
                        </s-banner>
                      )}

                      {seCorrigenSolos.length > 0 && (
                        <s-text variant="caption" tone="subdued">
                          ℹ️ {seCorrigenSolos.length} nombre(s) mal extraídos detectados en el feed.
                          No tienen producto publicado, así que la IA los resolverá al crearlos.
                          No requieren acción.
                        </s-text>
                      )}
                    </s-stack>
                  );
                })()}
              </s-stack>
            </s-card>
          </s-section>
        )}


        {/* PRODUCTOS ELIMINADOS: modelos huérfanos que ya no están en el feed.
            Se muestra por encima de la tabla de procesados; solo el modelo. */}
        {reconcileStatus && (
          <s-section>
            <s-card padding="base">
              <s-stack gap="base">
                {/* Cabecera con estado y contador */}
                <s-stack direction="inline" alignment="space-between" blockAlignment="center" gap="base">
                  <s-stack direction="inline" alignment="center" gap="200">
                    <s-text variant="heading-sm" fontWeight="semibold">
                      🗑️ Productos eliminados
                    </s-text>
                    <s-badge
                      tone={
                        reconcileStatus.phase === "error" ? "critical" :
                          reconcileStatus.phase === "skipped" ? "warning" :
                            (reconcileStatus.deleted?.length ? "critical" : "neutral")
                      }
                      size="small"
                    >
                      {reconcileStatus.deleted?.length || 0}
                    </s-badge>
                  </s-stack>

                  {reconcileStatus.phase === "running" && (
                    <s-stack direction="inline" alignment="center" gap="100">
                      <s-spinner size="small" />
                      <s-text variant="caption" tone="subdued">Eliminando…</s-text>
                    </s-stack>
                  )}
                </s-stack>

                {/* Mensajes de estado */}
                {reconcileStatus.phase === "skipped" && (
                  <s-banner tone="warning">
                    <s-text variant="body-sm">
                      ⚠️ Limpieza omitida porque hubo errores en algún grupo. No se han eliminado productos para evitar borrados accidentales.
                    </s-text>
                  </s-banner>
                )}

                {reconcileStatus.phase === "error" && (
                  <s-banner tone="critical">
                    <s-text variant="body-sm">
                      ❌ Error durante la limpieza: {reconcileStatus.errors?.[reconcileStatus.errors.length - 1]?.message || "desconocido"}
                    </s-text>
                  </s-banner>
                )}

                {reconcileStatus.phase === "done" && !reconcileStatus.deleted?.length && !reconcileStatus.errors?.length && (
                  <s-text variant="body-sm" tone="subdued">
                    ✅ No había productos obsoletos que eliminar.
                  </s-text>
                )}

                {/* Grid de chips con los modelos eliminados (sin variantes) */}
                {reconcileStatus.deleted?.length > 0 && (
                  <s-grid gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap="small">
                    {reconcileStatus.deleted.map((p, idx) => (
                      <s-box
                        key={`${p.id}-${idx}`}
                        padding="200"
                        background="subdued"
                        borderRadius="base"
                        borderColor="critical"
                        borderWidth="025"
                      >
                        <s-stack direction="inline" alignment="center" gap="100">
                          <s-icon type="delete" tone="critical" />
                          <s-text variant="body-sm" fontWeight="medium" className="capitalize">
                            <span className="capitalize">{p.title || p.id}</span>
                          </s-text>
                        </s-stack>
                      </s-box>
                    ))}
                  </s-grid>
                )}

                {/* Modelos que no se pudieron eliminar */}
                {reconcileStatus.errors?.length > 0 && reconcileStatus.errors.some(e => e.id) && (
                  <s-stack gap="tight">
                    <s-text variant="body-sm" fontWeight="semibold">
                      No se pudieron eliminar:
                    </s-text>
                    {reconcileStatus.errors.filter(e => e.id).map((p, idx) => (
                      <s-box key={`err-${p.id}-${idx}`} padding="tight" background="subdued" borderRadius="base">
                        <s-text variant="body-sm">⚠️ {p.title || p.id} — {p.message}</s-text>
                      </s-box>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            </s-card>
          </s-section>
        )}

        {/* TABLA DE PRODUCTOS AGRUPADOS POR MODELO Y VARIANTES */}
        {groupStatus.length > 0 && (
          <s-section>
            <s-box padding="500">
              {/* Lista detallada de grupos */}
              <s-stack vertical spacing="300">
                <s-stack rowGap="large">
                  {paginated
                    .map(g => (
                      <s-box key={g.id} padding="small" >
                        <s-stack gap="small">

                          {/* CABECERA DEL GRUPO */}
                          <s-stack direction="inline" alignment="space-between" gap="base">
                            <s-stack direction="inline" alignment="center" gap="200">
                              {/* icono/estado */}
                              {g.status === "processing" ? (
                                <s-spinner size="small" />
                              ) : g.status === "pending" ? (
                                <s-icon type="clock" tone="neutral" />
                              ) : g.status === "success" ? (
                                <s-icon type="check-circle-filled" tone="success" />
                              ) : g.status === "unchanged" ? (
                                <s-icon type="minus-circle" tone="subdued" />
                              ) : <s-icon type="alert-circle" tone="critical" />}

                              <s-text variant="body-md" fontWeight="semibold" className="capitalize">
                                <span className='capitalize'>{g.name || g.id}</span>
                              </s-text>
                            </s-stack>

                            <s-badge
                              tone={
                                g.status === "processing" ? "info" :
                                  g.status === "pending" ? "subdued" :
                                    g.status === "success" ? "success" : "critical"
                              }
                              size="small"
                            >
                              {g.status === "processing" && "En proceso…"}
                              {g.status === "pending" && "Pendiente"}
                              {g.status === "success" && "Completado"}
                              {g.status === "error" && "Con errores"}
                            </s-badge>
                          </s-stack>

                          {/* RESUMEN NÚMEROS */}
                          <s-stack direction="inline" columnGap="large" blockSize="auto" alignItems="center">
                            <s-badge tone="success" size="small">🆕 Creadas {g.created || 0}</s-badge>
                            <s-badge tone="info" size="small">🔄 Actualizadas {g.updated || 0}</s-badge>
                            <s-badge tone="warning" size="small">⏭️ Omitidas {g.skipped || 0}</s-badge>
                            {(g.deleted || 0) > 0 && <s-badge tone="critical" size="small">🗑️ Eliminadas {g.deleted}</s-badge>}
                            {(g.errors || 0) > 0 && <s-badge tone="critical" size="small">❌ Errores {g.errors}</s-badge>}
                            <s-text variant="caption" tone="subdued" style={{ marginLeft: 8 }}>
                              {g.totalVariants ? `${g.totalVariants} variantes` : ''}
                            </s-text>
                          </s-stack>

                          {(g.productNoChanges || (g.productChangedFields || []).length > 0) && (() => {
                            const campos = g.productChangedFields || [];
                            const descripcionCambiada = campos.includes("descriptionHtml");
                            const resto = etiquetarCampos(campos.filter(c => c !== "descriptionHtml"));

                            return (
                              <s-stack direction="inline" columnGap="small" blockSize="auto" alignItems="center">
                                {g.productNoChanges ? (
                                  <s-badge tone="subdued" size="small">📝 Producto sin cambios</s-badge>
                                ) : (
                                  <>
                                    {/* La descripción va en su propio badge: es el campo
                                        que regenera la IA y el que más interesa seguir. */}
                                    {descripcionCambiada && (
                                      <s-badge tone="success" size="small">📝 Descripción actualizada</s-badge>
                                    )}
                                    {resto.length > 0 && (
                                      <s-badge tone="info" size="small">
                                        ✏️ Actualizado: {resto.join(', ')}
                                      </s-badge>
                                    )}
                                  </>
                                )}
                              </s-stack>
                            );
                          })()}

                          <s-divider />

                          {/* VARIANTES: grid responsive */}
                          {variantStatusByGroup[g.id] && (
                            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(360px, 1fr))" gap="base" paddingBlockStart="200">
                              {Object.entries(variantStatusByGroup[g.id]).map(([sku, info]) => (
                                <s-box key={sku} padding="base">
                                  <s-stack direction="inline" alignment="start" columnGap="200">
                                    {/* Thumbnail / imagen */}
                                    <s-box blockSize="80px" inlineSize="80px" style={{ flex: '0 0 80px' }}>
                                      <s-image src={info?.variant?.image || ''} alt={sku} inlineSize="fill" />
                                    </s-box>

                                    {/* Datos */}
                                    <s-stack vertical spacing="100" style={{ flex: 1 }}>
                                      <s-text variant="body-sm" fontWeight="medium">
                                        {info?.variant?.capacity || ''} • {info?.variant?.color || ''} • {info?.variant?.condition || ''}
                                      </s-text>
                                      <s-text variant="caption" tone="subdued">{sku}</s-text>

                                      {/* Estado / acción */}
                                      <div style={{ marginTop: 8 }}>
                                        {info?.status === "detected_create" && <s-badge tone="info">Detectada (crear)</s-badge>}
                                        {info?.status === "detected_update" && <s-badge tone="info">Detectada (actualizar)</s-badge>}

                                        {info?.status === "processing" && (
                                          <s-badge tone="warning">
                                            <s-stack direction="inline" alignment="center" gap="100">
                                              <s-spinner size="small" /> Procesando…
                                            </s-stack>
                                          </s-badge>
                                        )}

                                        {info?.status === "success" && (
                                          <s-badge
                                            tone={info.action === "created"
                                              ? "success"
                                              : info.action === "updated"
                                                ? "info"
                                                : info.action === "skipped"
                                                  ? "warning"
                                                  : "critical"
                                            }
                                          >
                                            {info.action === "created"
                                              ? "Creada"
                                              : info.action === "updated"
                                                ? "Actualizada"
                                                : info.action === "skipped"
                                                  ? "Omitida"
                                                  : "Error"
                                            }
                                          </s-badge>
                                        )}

                                        {info?.status === "deleted" && (
                                          <s-badge tone="critical">🗑️ Eliminada (sin stock)</s-badge>
                                        )}

                                        {info?.status === "error" && (
                                          <s-badge tone="critical">Error{info.message ? `: ${info.message}` : ''}</s-badge>
                                        )}
                                      </div>
                                    </s-stack>
                                  </s-stack>
                                </s-box>
                              ))}
                            </s-grid>
                          )}
                        </s-stack>
                      </s-box>
                      // <s-box
                      //   key={g.id}
                      //   padding="base"
                      //   background={
                      //     g.status === "success" ? "subdued" :
                      //       g.status === "error" ? "strong" : "transparent"
                      //   }
                      //   borderRadius="large"
                      //   borderWidth="base"
                      //   borderColor={
                      //     g.status === "success" ? "subdued" :
                      //       g.status === "error" ? "strong" : "base"
                      //   }
                      // >
                      //   <s-stack alignment="space-between" rowGap='large'>
                      //     <s-stack gap="large-200">
                      //       <s-stack direction='inline' spacing="300" alignment="center">
                      //         <s-stack direction="inline">
                      //           {g.status === "processing" ? (
                      //             <s-spinner size="small" />
                      //           ) : (
                      //             <s-icon type={
                      //               g.status === "pending" ? "clock" :
                      //                 g.status === "success" ? "check-circle-filled" : null
                      //             }
                      //               tone={
                      //                 g.status === "pending" ? "neutral" :
                      //                   g.status === "success" ? "success" : null
                      //               }
                      //             />
                      //           )}
                      //           <s-text variant="bodyMd" fontWeight="semibold">
                      //             <span className='capitalize'>{g.id}</span>
                      //           </s-text>
                      //         </s-stack>
                      //       </s-stack>

                      //       {/* Mensaje de error si existe */}
                      //       {g.status === "error" && g.error && (
                      //         <s-box paddingBlockStart="100">
                      //           <s-banner tone="critical" hideIcon>
                      //             <s-text variant="bodySm">
                      //               {g.error}
                      //             </s-text>
                      //           </s-banner>
                      //         </s-box>
                      //       )}
                      //     </s-stack>

                      //     {variantStatusByGroup[g.id] && (
                      //       <s-grid gridTemplateColumns="repeat(auto-fit, minmax(400px, 1fr))" gap="400" paddingBlockStart="200">
                      //         {Object.entries(variantStatusByGroup[g.id]).map(([sku, info]) => (
                      //           <s-stack
                      //             key={sku}
                      //             direction="inline"
                      //             spacing="300"
                      //             alignment="center"
                      //             borderWidth="025"
                      //             borderColor="border-subdued"
                      //             padding="200"
                      //             borderRadius="200"
                      //           >
                      //             <s-box blockSize='100px' inlineSize='100px'>
                      //               <s-image
                      //                 src={info?.variant?.image}
                      //                 alt={info?.variant?.title || sku}
                      //                 inlineSize="fill"
                      //               />
                      //             </s-box>

                      //             {/* SKU / descripción */}
                      //             <s-text variant="bodySm" fontWeight="medium">
                      //               {info?.variant?.capacity} / {info?.variant?.color} / {info?.variant?.condition}
                      //             </s-text>

                      //             {/* ESTADOS */}
                      //             {info?.status === "detected_create" && (
                      //               <s-badge tone="info">Detectada (crear)</s-badge>
                      //             )}

                      //             {info?.status === "detected_update" && (
                      //               <s-badge tone="info">Detectada (actualizar)</s-badge>
                      //             )}

                      //             {info?.status === "processing" && (
                      //               <s-badge tone="warning">
                      //                 <s-stack direction="inline" spacing="100" alignment="center">
                      //                   <s-spinner size="small" /> Procesando…
                      //                 </s-stack>
                      //               </s-badge>
                      //             )}

                      //             {info?.status === "success" && (
                      //               <s-badge tone="success">
                      //                 {info.action === "created" ? "Creada" : "Actualizada"}
                      //               </s-badge>
                      //             )}

                      //             {info.status === "error" && (
                      //               <s-badge tone="critical">
                      //                 Error: {info.message || "Desconocido"}
                      //               </s-badge>
                      //             )}
                      //           </s-stack>
                      //         ))}
                      //       </s-grid>
                      //     )}
                      //   </s-stack>
                      // </s-box>
                    ))}
                </s-stack>
              </s-stack>

              <Pagination
                page={page}
                totalPages={totalPages}
                totalItems={groupStatus.length}
                pageSize={pageSize}
                onChange={newPage => setPage(newPage)}
              />
            </s-box>
          </s-section>
        )}

      </s-page>
    </div>
  );
}