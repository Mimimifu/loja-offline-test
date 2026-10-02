/**
 * @file tests/suites/router.test.ts
 * @description Testes do roteador.
 *
 * ## Por que usam `createFakeEnv()`
 *
 * O roteador precisa de `location`/`history`. Testá-lo contra `window` real
 * significava **mudar a URL da página em que a suíte roda**: o `navigate()`
 * empilhava paths (`/a`, `/b`, `/nao-existe`) na barra de endereços, disparava
 * `hashchange` e deixava a aplicação fora de qualquer rota registrada — a tela
 * ficava em branco e os testes seguintes falhavam. Não eram falhas reais, era
 * o teste sabotando a aplicação.
 *
 * Com `createFakeEnv()` cada teste navega num ambiente em memória: isolado,
 * determinístico e sem efeito colateral.
 *
 * ## Regressão histórica coberta
 *
 * No log de conversas do projeto, o usuário relatou: *"a parte de edição não
 * carregou os dados na hora de editar"*. A causa era extrair o id por posição
 * fixa do segmento (`hash.split('/')[2]`) combinada com comparação por
 * igualdade estrita. A extração nomeada de parâmetros é testada aqui.
 */

import { assert, testRunner } from '../testRunner';
import { Router, RouteContext, RouterMode } from '../../core/router';
import { createFakeEnv, FakeEnv } from '../../core/routerEnv';

/**
 * Executa um teste com um roteador isolado.
 * @param fn Corpo do teste.
 * @param options Modo e protocolo do ambiente simulado.
 */
function withRouter(
    fn: (router: Router, env: FakeEnv) => void,
    options: { mode?: RouterMode; protocol?: string; pathname?: string } = {},
): void {
    const env = createFakeEnv(options.protocol ?? 'https:', options.pathname ?? '/');
    const router = new Router('', { mode: options.mode, env });

    try {
        fn(router, env);
    } finally {
        router.stop();
    }
}

/** Registra a suíte de roteamento. */
export function registerRouterSuite(): void {
    testRunner.describe('🗺️ [Router] Navegação', () => {
        testRunner.it('normaliza barras finais e a raiz', () => {
            withRouter((router) => {
                router.navigate('/produtos/');
                assert.equal(router.getCurrentPath(), '/produtos', 'barra final deve ser removida');

                router.navigate('/');
                assert.equal(router.getCurrentPath(), '/', 'a raiz deve permanecer "/"');
            }, { mode: 'history' });
        });

        testRunner.it('extrai parâmetros de rota /produto/:id', () => {
            withRouter(
                (router) => {
                    let captured: RouteContext | null = null;
                    router.addRoute('/produto/:id', (context) => {
                        captured = context;
                    });

                    router.navigate('/produto/abc-123');

                    assert.ok(captured !== null, 'handler deve ter sido chamado');
                    assert.equal((captured as unknown as RouteContext).params.id, 'abc-123', 'id extraído por nome');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('preserva ids com caracteres especiais e acentos', () => {
            withRouter(
                (router) => {
                    let capturedId = '';
                    router.addRoute('/produto/:id', (context) => {
                        capturedId = context.params.id;
                    });

                    router.navigate(`/produto/${encodeURIComponent('café-com-acentuação')}`);

                    assert.equal(capturedId, 'café-com-acentuação', 'deve decodificar o parâmetro');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('tolera parâmetro percent-encoded malformado', () => {
            withRouter(
                (router) => {
                    let capturedId = '';
                    router.addRoute('/produto/:id', (context) => {
                        capturedId = context.params.id;
                    });

                    // `decodeURIComponent('%E0%A4%A')` lança URIError; não pode quebrar.
                    router.navigate('/produto/%E0%A4%A');

                    assert.equal(capturedId, '%E0%A4%A', 'valor malformado é devolvido como veio');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('não confunde rotas com número diferente de segmentos', () => {
            withRouter(
                (router) => {
                    let editCalled = false;
                    router.addRoute('/admin', () => undefined);
                    router.addRoute('/admin/editar/:id', () => {
                        editCalled = true;
                    });

                    router.navigate('/admin');
                    assert.notOk(editCalled, 'rota curta não deve casar com a longa');

                    router.navigate('/admin/editar/7');
                    assert.ok(editCalled, 'rota longa deve casar');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('não casa rota parcial (segmento extra)', () => {
            withRouter(
                (router) => {
                    let called = false;
                    router.addRoute('/produtos', () => {
                        called = true;
                    });

                    router.navigate('/produtos/inexistente');
                    assert.notOk(called, '"/produtos/x" não deve casar com "/produtos"');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('expõe query string no contexto', () => {
            withRouter(
                (router) => {
                    let categoria: string | null = null;
                    router.addRoute('/produtos', (context) => {
                        categoria = context.query.get('categoria');
                    });

                    router.navigate('/produtos?categoria=pdf');

                    assert.equal(categoria, 'pdf', 'query deve ser parseada');
                    assert.equal(router.getCurrentPath(), '/produtos', 'query não faz parte do path');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('notifica assinantes em cada navegação', () => {
            withRouter(
                (router) => {
                    router.addRoute('/a', () => undefined);
                    router.addRoute('/b', () => undefined);

                    const visited: string[] = [];
                    router.subscribe((context) => visited.push(context.path));

                    router.navigate('/a');
                    router.navigate('/b');

                    assert.deepEqual(visited, ['/a', '/b'], 'assinante deve ver as duas rotas');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('navegação para o mesmo path não duplica entrada no histórico', () => {
            withRouter(
                (router, env) => {
                    router.addRoute('/a', () => undefined);

                    router.navigate('/a');
                    const afterFirst = env.pushCount();
                    router.navigate('/a');

                    assert.equal(env.pushCount(), afterFirst, 'segunda navegação não deve empilhar');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('navigate com replace não empilha histórico', () => {
            withRouter(
                (router, env) => {
                    router.addRoute('/a', () => undefined);
                    router.addRoute('/b', () => undefined);

                    router.navigate('/a');
                    const afterPush = env.pushCount();
                    router.navigate('/b', { replace: true });

                    assert.equal(env.pushCount(), afterPush, 'replace não deve crescer o histórico');
                    assert.equal(router.getCurrentPath(), '/b', 'path deve ser atualizado');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('rota não registrada não lança nem trava o roteador', () => {
            withRouter(
                (router) => {
                    router.addRoute('/a', () => undefined);

                    router.navigate('/nao-existe');
                    assert.equal(router.getCurrentPath(), '/nao-existe', 'path é atualizado mesmo sem rota');

                    router.navigate('/a');
                    assert.equal(router.getCurrentPath(), '/a', 'roteador segue funcionando');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('impede registro duplicado de rota', () => {
            withRouter(
                (router) => {
                    router.addRoute('/a', () => undefined);

                    let threw = false;
                    try {
                        router.addRoute('/a', () => undefined);
                    } catch {
                        threw = true;
                    }
                    assert.ok(threw, 'registrar a mesma rota duas vezes deve falhar');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('erro dentro do handler não quebra o roteador', () => {
            withRouter(
                (router) => {
                    router.addRoute('/explode', () => {
                        throw new Error('handler quebrado');
                    });
                    router.addRoute('/ok', () => undefined);

                    router.navigate('/explode');
                    router.navigate('/ok');

                    assert.equal(router.getCurrentPath(), '/ok', 'roteador deve continuar utilizável');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('subscribe devolve cancelamento funcional', () => {
            withRouter(
                (router) => {
                    router.addRoute('/a', () => undefined);
                    router.addRoute('/b', () => undefined);

                    let calls = 0;
                    const unsubscribe = router.subscribe(() => {
                        calls += 1;
                    });

                    router.navigate('/a');
                    unsubscribe();
                    router.navigate('/b');

                    assert.equal(calls, 1, 'não deve notificar após cancelar');
                },
                { mode: 'history' },
            );
        });

        /* ------------------------------------------------- modo hash ------ */

        testRunner.it('detecta modo hash sob protocolo file://', () => {
            const env = createFakeEnv('file:', '/home/user/dist/index.html');
            const router = new Router('', { env });

            assert.equal(router.modeName, 'hash', 'file:// deve forçar modo hash');
            router.stop();
        });

        testRunner.it('modo hash resolve rotas e parâmetros', () => {
            withRouter(
                (router) => {
                    let capturedId = '';
                    router.addRoute('/', () => undefined);
                    router.addRoute('/produto/:id', (context) => {
                        capturedId = context.params.id;
                    });

                    router.navigate('/produto/abc-9');

                    assert.equal(router.getCurrentPath(), '/produto/abc-9', 'path resolvido em modo hash');
                    assert.equal(capturedId, 'abc-9', 'parâmetro extraído em modo hash');
                },
                { mode: 'hash' },
            );
        });

        testRunner.it('modo hash gera href pronto para âncora', () => {
            withRouter(
                (router) => {
                    assert.equal(router.hrefFor('/produtos'), '#/produtos', 'href em modo hash');
                    assert.equal(router.hrefFor('admin'), '#/admin', 'normaliza barra inicial');
                },
                { mode: 'hash' },
            );
        });

        testRunner.it('modo history devolve o href original', () => {
            withRouter(
                (router) => {
                    assert.equal(router.hrefFor('/produtos'), '/produtos', 'href em modo history');
                },
                { mode: 'history' },
            );
        });

        testRunner.it('query string sobrevive à navegação em modo hash', () => {
            withRouter(
                (router) => {
                    let categoria: string | null = null;
                    router.addRoute('/produtos', (context) => {
                        categoria = context.query.get('categoria');
                    });

                    router.navigate('/produtos?categoria=curso');

                    assert.equal(categoria, 'curso', 'query preservada em modo hash');
                },
                { mode: 'hash' },
            );
        });

        testRunner.it('navegação repetida em modo hash não acumula fragmentos', () => {
            withRouter(
                (router, env) => {
                    router.addRoute('/a', () => undefined);

                    router.navigate('/a');
                    const firstHash = env.currentHash();
                    router.navigate('/a');

                    assert.equal(env.currentHash(), firstHash, 'fragmento estável');
                    assert.equal(router.getCurrentPath(), '/a', 'path estável');
                },
                { mode: 'hash' },
            );
        });

        testRunner.it('modo hash interpreta o fragmento inicial como rota', () => {
            const env = createFakeEnv('https:', '/');
            env.setUrl('https://local/#/produto/42');

            let capturedId = '';
            const router = new Router('', { mode: 'hash', env });
            router.addRoute('/produto/:id', (context) => {
                capturedId = context.params.id;
            });
            router.start();

            assert.equal(capturedId, '42', 'rota inicial do fragmento deve resolver');

            router.stop();
        });

        testRunner.it('voltar do navegador (popstate) reexecuta a rota', () => {
            withRouter(
                (router, env) => {
                    let currentPath = '';
                    router.addRoute('/a', (context) => {
                        currentPath = context.path;
                    });
                    router.addRoute('/b', (context) => {
                        currentPath = context.path;
                    });

                    router.start();

                    router.navigate('/a');
                    assert.equal(currentPath, '/a', 'rota /a executada');

                    // Simula o botão "voltar": a URL muda e o evento é emitido.
                    env.setUrl('https://local/b');
                    env.emit('popstate');

                    assert.equal(currentPath, '/b', 'handler deve rodar no popstate');
                },
                { mode: 'history' },
            );
        });
    });
}
