/**
 * Vercel.
 *
 * Read plus redeploy. Creating a deployment from scratch means uploading a file tree,
 * which is a different job from what this CLI does; redeploying an existing deployment
 * is the operation people actually want from a terminal.
 */
export declare const vercel: {
    whoami(): Promise<any>;
    projects(limit?: number): Promise<any>;
    deployments(opts?: {
        project?: string;
        limit?: number;
    }): Promise<any>;
    /**
     * Redeploy an existing deployment.
     *
     * `deploymentId` plus the target is enough — Vercel reuses the source of the
     * referenced deployment, which is why this does not need a file upload.
     */
    redeploy(deploymentId: string, name: string, target?: "production" | "preview"): Promise<any>;
    project(name: string): Promise<any>;
    createProject(input: {
        name: string;
        framework?: string;
        gitRepo?: string;
    }): Promise<any>;
    deleteProject(name: string): Promise<void>;
    deployment(idOrUrl: string): Promise<any>;
    /** Build and runtime events for one deployment — what you want when a deploy failed. */
    deploymentEvents(id: string, limit?: number): Promise<any>;
    cancelDeployment(id: string): Promise<any>;
    addEnv(projectId: string, input: {
        key: string;
        value: string;
        target: string[];
        type?: string;
    }): Promise<any>;
    removeEnv(projectId: string, envId: string): Promise<void>;
    domains(projectId: string): Promise<any>;
    addDomain(projectId: string, name: string): Promise<any>;
    removeDomain(projectId: string, name: string): Promise<void>;
    envVars(projectId: string): Promise<any>;
};
