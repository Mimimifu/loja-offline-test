/**
 * @file core/types.ts
 * @description Contratos de domínio compartilhados por toda a aplicação.
 *
 * Módulo puramente declarativo: o `tsc` elide estes imports no build, portanto
 * não gera peso no bundle final.
 */

/** Categorias de produto digital suportadas pela vitrine. */
export type ProductCategory = 'pdf' | 'musica' | 'planilha' | 'curso' | 'template' | 'outro';

/** Produto digital à venda. */
export interface Product {
    id: string;
    title: string;
    category: ProductCategory;
    /** Preço em centavos — inteiro, para evitar erros de ponto flutuante. */
    priceCents: number;
    description: string;
    /** URL de imagem (ou data-URL base64). */
    image: string;
    /** Link de pagamento/doação (PayPal, Mercado Pago, Pix, etc). */
    paymentLink: string;
    /** Link do arquivo entregue após o pagamento. */
    downloadLink: string;
    /** Rótulo do botão de pagamento (ex: "Comprar", "Doar"). */
    paymentLabel: string;
    tags: string[];
    /** Se `false`, o item fica oculto na vitrine. */
    published: boolean;
    createdAt: number;
    updatedAt: number;
}

/** Tema visual da aplicação. */
export type ThemeName = 'light' | 'dark';

/** Lado em que a barra lateral é exibida. */
export type SidebarSide = 'left' | 'right';

/** Preferências do usuário — persistidas com número de versão para migração. */
export interface Settings {
    version: number;
    theme: ThemeName;
    sidebarSide: SidebarSide;
    sidebarCollapsed: boolean;
    accentColor: string;
    gridDensity: 'comfortable' | 'compact';
}

/** Definição de um campo de formulário gerado dinamicamente. */
export interface FieldSchema {
    id: string;
    label: string;
    type: 'text' | 'textarea' | 'number' | 'url' | 'select' | 'checkbox' | 'tags';
    placeholder?: string;
    required?: boolean;
    /** Chave em `Product` onde o valor é lido/escrito (permite aninhar). */
    path: string;
    options?: { value: string; label: string }[];
    help?: string;
    /** Multiplicador aplicado no parse/serialize (ex: 100 para preço em centavos). */
    scale?: number;
}

/** Esquema completo do formulário — editável pelo usuário na aba Configurações. */
export interface FormSchema {
    version: number;
    fields: FieldSchema[];
}

/** Estado global da aplicação. */
export interface AppStateData {
    products: Product[];
    settings: Settings;
    formSchema: FormSchema;
    /** Última sincronização bem-sucedida com a API externa (epoch ms). */
    lastSyncAt: number | null;
    /** Fila de operações pendentes de envio à API. */
    pendingOps: PendingOperation[];
    isOnline: boolean;
}

/** Operação enfileirada para sincronização futura (padrão outbox). */
export interface PendingOperation {
    id: string;
    kind: 'create' | 'update' | 'delete';
    productId: string;
    createdAt: number;
}

/** Envelope de backup exportado/importado. */
export interface BackupEnvelope {
    app: 'digital-store-pro';
    version: number;
    exportedAt: string;
    state: Pick<AppStateData, 'products' | 'settings' | 'formSchema'>;
}
