/*
 * Copyright (c) 2018-2020 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import { inject, injectable } from 'inversify';
import { convertDevWorkspaceV2ToV1, isDeleting, isWebTerminal } from '../helpers/devworkspace';
import { WorkspaceClient } from './';
import { DevWorkspaceClient as DevWorkspaceClientLibrary, IDevWorkspaceApi, IDevWorkspaceDevfile, IDevWorkspace, IDevWorkspaceTemplateApi, IDevWorkspaceTemplate } from '@eclipse-che/devworkspace-client';
import { DevWorkspaceStatus, WorkspaceStatus } from '../helpers/types';
import { KeycloakSetupService } from '../keycloak/setup';
import { delay } from '../helpers/delay';
import { RestApi } from '@eclipse-che/devworkspace-client/dist/browser';

export interface IStatusUpdate {
  error?: string;
  status?: string;
  prevStatus?: string;
  workspaceId: string;
}

const TheiaDevfile = <IDevWorkspaceDevfile>{
  schemaVersion: '2.1.0',
  commands: [
    {
      id: 'init-container-command',
      apply: {
        component: 'remote-runtime-injector'
      }
    }
  ],
  events: {
    preStart: [
      'init-container-command'
    ]
  },
  components: [
    {
      name: 'plugins',
      volume: {}
    },
    {
      name: 'theia-local',
      volume: {}
    },
    {
      name: 'theia-ide',
      container: {
        image: 'quay.io/eclipse/che-theia@sha256:0efc94a17a0c655b37d90f5a29ea876c78af9f9bebc2b4494b1060723b07c6f9',
        env: [
          {
            name: 'THEIA_PLUGINS',
            value: 'local-dir:///plugins'
          },
          {
            name: 'HOSTED_PLUGIN_HOSTNAME',
            value: '0.0.0.0'
          },
          {
            name: 'HOSTED_PLUGIN_PORT',
            value: '3130'
          },
          {
            name: 'THEIA_HOST',
            value: '0.0.0.0'
          }
        ],
        volumeMounts: [
          {
            name: 'plugins',
            path: '/plugins'
          },
          {
            name: 'theia-local',
            path: '/home/theia/.theia'
          }
        ],
        mountSources: true,
        memoryLimit: '512M',
        endpoints: [
          {
            name: 'theia',
            attributes: {
              type: 'ide',
              cookiesAuthEnabled: true,
              discoverable: false
            },
            targetPort: 3100,
            exposure: 'public',
            secure: false,
            protocol: 'http'
          },
          {
            name: 'webviews',
            attributes: {
              type: 'webview',
              cookiesAuthEnabled: true,
              discoverable: false,
              unique: true
            },
            targetPort: 3100,
            exposure: 'public',
            secure: false,
            protocol: 'http'
          },
          {
            name: 'mini-browser',
            attributes: {
              type: 'mini-browser',
              cookiesAuthEnabled: true,
              discoverable: false,
              unique: true
            },
            targetPort: 3100,
            exposure: 'public',
            secure: false,
            protocol: 'http'
          },
          {
            name: 'theia-dev',
            attributes: {
              type: 'ide-dev',
              discoverable: false
            },
            targetPort: 3130,
            exposure: 'public',
            protocol: 'http'
          },
          {
            name: 'theia-redirect-1',
            attributes: {
              discoverable: false
            },
            targetPort: 13131,
            exposure: 'public',
            protocol: 'http'
          },
          {
            name: 'theia-redirect-2',
            attributes: {
              discoverable: false
            },
            targetPort: 13132,
            exposure: 'public',
            protocol: 'http'
          },
          {
            name: 'theia-redirect-3',
            attributes: {
              discoverable: false
            },
            targetPort: 13133,
            exposure: 'public',
            protocol: 'http'
          }
        ]
      }
    },
    {
      name: 'remote-endpoint',
      volume: {
        ephemeral: true
      }
    },
    {
      name: 'remote-runtime-injector',
      container: {
        image: 'quay.io/eclipse/che-theia-endpoint-runtime-binary@sha256:55a740a3a6c6e7e23f96fd0d8f23bba573a42a94abe01c6696d32045ba833ba7',
        env: [
          {
            name: 'PLUGIN_REMOTE_ENDPOINT_EXECUTABLE',
            value: '/remote-endpoint/plugin-remote-endpoint'
          },
          {
            name: 'REMOTE_ENDPOINT_VOLUME_NAME',
            value: 'remote-endpoint'
          }
        ],
        volumeMounts: [
          {
            name: 'remote-endpoint',
            path: '/remote-endpoint'
          }
        ]
      }
    }
  ]
};

/**
 * This class manages the connection between the frontend and the devworkspace typescript library
 */
@injectable()
export class DevWorkspaceClient extends WorkspaceClient {

  private workspaceApi: IDevWorkspaceApi;
  private dwtApi: IDevWorkspaceTemplateApi;
  private previousItems: Map<string, Map<string, IStatusUpdate>>;
  private _defaultEditor?: string;
  private _defaultPlugins?: string[];
  private client: RestApi;
  private maxStatusAttempts: number;
  private initializing: Promise<void>;

  constructor(@inject(KeycloakSetupService) keycloakSetupService: KeycloakSetupService) {
    super(keycloakSetupService);
    this.axios.defaults.baseURL = '/api/unsupported/k8s';
    this.client = DevWorkspaceClientLibrary.getRestApi(this.axios);
    this.workspaceApi = this.client.workspaceApi;
    this.dwtApi = this.client.templateApi;
    this.previousItems = new Map();
    this.maxStatusAttempts = 10;
  }

  isEnabled(): Promise<boolean> {
    return this.client.isDevWorkspaceApiEnabled();
  }

  async getAllWorkspaces(defaultNamespace: string): Promise<che.Workspace[]> {
    await this.initializing;
    const workspaces = await this.workspaceApi.listInNamespace(defaultNamespace);
    const availableWorkspaces: che.Workspace[] = [];
    for (const workspace of workspaces) {
      if (!isDeleting(workspace) && !isWebTerminal(workspace)) {
        availableWorkspaces.push(convertDevWorkspaceV2ToV1(workspace));
      }
    }
    return availableWorkspaces;
  }

  async getWorkspaceByName(namespace: string, workspaceName: string): Promise<che.Workspace> {
    let workspace = await this.workspaceApi.getByName(namespace, workspaceName);
    let attempted = 0;
    while ((!workspace.status || !workspace.status.phase || !workspace.status.ideUrl) && attempted < this.maxStatusAttempts) {
      workspace = await this.workspaceApi.getByName(namespace, workspaceName);
      this.checkForDevWorkspaceError(workspace);
      attempted += 1;
      await delay();
    }
    this.checkForDevWorkspaceError(workspace);
    if (!workspace.status || !workspace.status.phase || !workspace.status.ideUrl) {
      throw new Error(`Could not retrieve devworkspace status information from ${workspaceName} in namespace ${namespace}`);
    }
    return convertDevWorkspaceV2ToV1(workspace);
  }

  async create(devfile: IDevWorkspaceDevfile): Promise<che.Workspace> {
    const theiaDWT = await this.dwtApi.create(<IDevWorkspaceTemplate>{
      kind: 'DevWorkspaceTemplate',
      apiVersion: 'workspace.devfile.io/v1alpha2',
      metadata: {
        name: 'eclipse-che-theia-latest',
        namespace: devfile.metadata.namespace,
      },
      spec: TheiaDevfile
    });

    if (!devfile.components) {
      devfile.components = [];
    }
    devfile.components.push({
      name: theiaDWT.metadata.name,
      plugin: {
        kubernetes: {
          name: theiaDWT.metadata.name,
          namespace: theiaDWT.metadata.namespace
        }
      }
    });

    const createdWorkspace = await this.workspaceApi.create(devfile);
    return convertDevWorkspaceV2ToV1(createdWorkspace);
  }

  delete(namespace: string, name: string): void {
    this.workspaceApi.delete(namespace, name);
  }

  async changeWorkspaceStatus(namespace: string, name: string, started: boolean): Promise<che.Workspace> {
    const changedWorkspace = await this.workspaceApi.changeStatus(namespace, name, started);
    this.checkForDevWorkspaceError(changedWorkspace);
    return convertDevWorkspaceV2ToV1(changedWorkspace);
  }

  /**
   * Initialize the given namespace
   * @param namespace The namespace you want to initialize
   * @returns If the namespace has been initialized
   */
  async initializeNamespace(namespace: string): Promise<boolean> {
    try {
      this.initializing = new Promise((resolve, reject) => {
        this.workspaceApi.initializeNamespace(namespace).then(_ => {
          resolve(undefined);
        });
      });
      await this.initializing;
    } catch (e) {
      console.error(e);
      return false;
    }
    return true;
  }

  subscribeToNamespace(
    defaultNamespace: string,
    callback: any,
    dispatch: any
  ): void {
    setInterval(async () => {
      // This is a temporary solution until websockets work. Ideally we should just have a websocket connection here.
      const devworkspaces = await this.getAllWorkspaces(defaultNamespace);
      devworkspaces.forEach((devworkspace: che.Workspace) => {
        const statusUpdate = this.createStatusUpdate(devworkspace);
        callback(
          {
            id: devworkspace.id,
          } as che.Workspace,
          statusUpdate
        )(dispatch);
      });
    }, 1000);
  }

  /**
   * Create a status update between the previously recieving DevWorkspace with a certain workspace id
   * and the new DevWorkspace
   * @param devworkspace The incoming DevWorkspace
   */
  private createStatusUpdate(devworkspace: che.Workspace): IStatusUpdate {
    const namespace = devworkspace.namespace as string;
    const workspaceId = devworkspace.id;
    // Starting devworkspaces don't have status defined
    const status = devworkspace.status && typeof devworkspace.status === 'string' ? devworkspace.status.toUpperCase() : WorkspaceStatus[WorkspaceStatus.STARTING];

    const prevWorkspace = this.previousItems.get(namespace);
    if (prevWorkspace) {
      const prevStatus = prevWorkspace.get(workspaceId);
      const newUpdate: IStatusUpdate = {
        workspaceId: workspaceId,
        status: status,
        prevStatus: prevStatus?.status,
      };
      prevWorkspace.set(workspaceId, newUpdate);
      return newUpdate;
    } else {
      // there is not a previous update
      const newStatus: IStatusUpdate = {
        workspaceId,
        status: status,
        prevStatus: status,
      };

      const newStatusMap = new Map<string, IStatusUpdate>();
      newStatusMap.set(workspaceId, newStatus);
      this.previousItems.set(namespace, newStatusMap);
      return newStatus;
    }
  }

  set defaultEditor(editor: string) {
    this._defaultEditor = editor;
  }

  set defaultPlugins(plugins: string[]) {
    this._defaultPlugins = plugins;
  }

  checkForDevWorkspaceError(devworkspace: IDevWorkspace) {
    const currentPhase = devworkspace.status?.phase;
    if (currentPhase && currentPhase.toUpperCase() === DevWorkspaceStatus[DevWorkspaceStatus.FAILED]) {
      const message = devworkspace.status.message;
      if (message) {
        throw new Error(devworkspace.status.message);
      }
      throw new Error('Unknown error occured when trying to process the devworkspace');
    }
  }
}
