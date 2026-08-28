# OpenDelegate

Idiomas: [English](README.md) · [한국어](README.ko.md) · **Español**

OpenDelegate es un repositorio SSH-first para instalar y operar Agents de Hermes en varios
ordenadores. No es un sitio Web de administración independiente.

Flujo actual:

- el Agent Origin usa SSH para instalar, actualizar y recuperar Hermes en cada Device;
- después de la configuración, el trabajo normal se envía mediante la Hermes Peer API;
- el tráfico de la API Peer usa Tailscale u otro transporte privado cifrado;
- la configuración, credenciales, sesiones, memoria y bases de datos de Hermes permanecen en cada
  Device;
- OpenDelegate no utiliza Admin Web ni Enrollment Grant.

## Inicio rápido

```sh
hermes doctor
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
hermes skills trust
hermes
```

En una sesión nueva de Hermes, pide:

> Usa este ordenador como Origin. Conéctate a los otros Devices mediante mis alias SSH existentes,
> instala o actualiza Hermes, configura el rol, la Peer API y el servicio Gateway de cada Device,
> regístralos en Origin y verifica una solicitud y respuesta reales. Mantén las credenciales y el
> estado de Hermes de forma local en cada Device y nunca aceptes un cambio inesperado de la clave SSH
> del host.

Consulta el [README en inglés](README.md), el [README en coreano](README.ko.md) y la
[guía de inicio](docs/GETTING_STARTED.md) para ver el procedimiento completo.
