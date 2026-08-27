# OpenDelegate

Langues : [English](README.md) · [한국어](README.ko.md) · **Français**

OpenDelegate est un dépôt SSH-first destiné à installer et exploiter des Agents Hermes sur plusieurs
ordinateurs. Ce n'est pas un site Web d'administration séparé.

Fonctionnement actuel :

- l'Agent Origin utilise SSH pour installer, mettre à jour et réparer Hermes sur chaque Device ;
- après l'installation, les tâches ordinaires passent par l'API Peer de Hermes ;
- Tailscale, le LAN ou un VPN existant fournit la connectivité ;
- la configuration, les identifiants, les sessions, la mémoire et les bases Hermes restent sur chaque
  Device ;
- OpenDelegate n'utilise ni Admin Web ni Enrollment Grant.

## Démarrage rapide

```sh
hermes doctor
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
hermes skills trust
hermes
```

Dans une nouvelle session Hermes, demandez :

> Utilise cet ordinateur comme Origin. Connecte-toi aux autres Devices avec mes alias SSH existants,
> installe ou mets à jour Hermes, configure le rôle, l'API Peer et le service Gateway de chaque
> Device, enregistre-les sur Origin et vérifie une vraie requête et sa réponse. Conserve les
> identifiants et l'état Hermes localement sur chaque Device et n'accepte jamais une modification
> inattendue de la clé d'hôte SSH.

Pour la procédure complète, consultez le [README anglais](README.md), le
[README coréen](README.ko.md) et le [guide de démarrage](docs/GETTING_STARTED.md).
