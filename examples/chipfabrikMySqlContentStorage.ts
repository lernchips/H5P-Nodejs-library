import { 
    IContentStorage,
    IContentMetadata,
    IUser,
    ContentId,
    IFileStats,
    ContentParameters,
    ILibraryName,
    Permission,
    H5pError } from '../src';
import { hasDependencyOn } from '../src/helpers/DependencyChecker';
import { checkFilename, sanitizeFilename } from '../src/implementation/fs/filenameUtils';
import { Stream } from 'stream';
import { ReadStream } from 'fs';
import fsExtra from 'fs-extra';
import path from 'path';
import promisepipe from 'promisepipe';
import globPromise from 'glob-promise';
import  * as mysql from 'mysql';

export default class ChipfabrikMySqlContentStorage implements IContentStorage {
    private _connection: mysql.Connection;

    constructor(
        private _options: {
            contentPath: string;
            mysqlHost: string;
            mysqlUser: string;
            mysqlPassword: string;
            mysqlDatabase: string;
        }
    ) {
        this._connection = mysql.createConnection({
            host: _options.mysqlHost,
            user: _options.mysqlUser,
            password: _options.mysqlPassword,
            database: _options.mysqlDatabase
        });
        this.init();
    }

    private init(): void {
        const createTableQuery = 
            'CREATE TABLE IF NOT EXISTS content(' +
                'id INT UNSIGNED NOT NULL AUTO_INCREMENT, ' +
                'content JSON NOT NULL, ' +
                'metadata JSON NOT NULL, ' +
                'PRIMARY KEY (id),' +
                'CHECK (JSON_VALID(content)), ' +
                'CHECK (JSON_VALID(metadata))' +
            ')';
        this._connection.query(createTableQuery, function (error, results, fields) {
            if (error) {
                throw error;
            }
        });
    }

    public async addContent(
        metadata: IContentMetadata,
        content: any,
        user: IUser,
        contentId?: ContentId
    ): Promise<ContentId> {
        return new Promise((resolve, reject) => {
            const metadataJson = JSON.stringify(metadata);
            const contentJson = JSON.stringify(content);

            const updateExisting = contentId !== undefined && contentId !== null;
            if (updateExisting) {
                this._connection.query('UPDATE content SET metadata = ?, content = ? WHERE id = ?', [metadataJson, contentJson, contentId], function (error, results, fields){
                    if (error) {
                        reject(error);
                    }

                    resolve(contentId);
                });
            } else {
                this._connection.query('INSERT INTO content(metadata, content) VALUES (?, ?)', [metadataJson, contentJson], function (error, results, fields){
                    if (error) {
                        reject(error);
                    }

                    resolve(results.insertId);
                });
            }
        });
    }

    public async addFile(
        contentId: ContentId,
        filename: string,
        readStream: Stream,
        user?: IUser
    ): Promise<void> {
        checkFilename(filename);

        const fullPath = path.join(this._options.contentPath, contentId, filename);
        await fsExtra.ensureDir(path.dirname(fullPath));

        const writeStream = fsExtra.createWriteStream(fullPath);
        await promisepipe(readStream, writeStream);
    }

    public async contentExists(contentId: ContentId): Promise<boolean> {
        return new Promise((resolve, reject) => {
            this._connection.query('SELECT count(*) as count FROM content WHERE id = ?', [contentId], function (error, results, fields){
                if (error) {
                    reject(error);
                }

                if (results[0].count === 0) {
                    resolve(false);
                    return;
                }

                resolve(true);
            });
        });
    }

    public async deleteContent(contentId: ContentId, user?: IUser): Promise<void> {
        const contentPath = path.join(this._options.contentPath, contentId);

        if (await fsExtra.pathExists(contentPath)) {
            await fsExtra.remove(contentPath);
        }

        this._connection.query('DELETE FROM content WHERE id = ?', [contentId], function (error, results, fields){
            if (error) {
                throw error;
            }
        });
    }

    public async deleteFile(
        contentId: ContentId,
        filename: string,
        user?: IUser
    ): Promise<void> {
        checkFilename(filename);

        const absolutePath = path.join(
            this._options.contentPath,
            contentId,
            filename
        );

        if (!(await fsExtra.pathExists(absolutePath))) {
            throw new H5pError(
                'storage-file-implementations:delete-content-file-not-found',
                { filename },
                404
            );
        }

        await fsExtra.remove(absolutePath);
    }

    public async fileExists(contentId: ContentId, filename: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            checkFilename(filename);

            if (contentId !== undefined) {
                const pathExists = fsExtra.pathExists(
                    path.join(this._options.contentPath, contentId, filename)
                );
                resolve(pathExists);
            }

            resolve(false);
        });
    }

    public async getFileStats(
        contentId: ContentId,
        file: string,
        user: IUser
    ): Promise<IFileStats> {
        if (!(await this.fileExists(contentId, file))) {
            throw new H5pError(
                'content-file-missing',
                { file, contentId: contentId },
                404
            );
        }

        return fsExtra.stat(
            path.join(this._options.contentPath, contentId, file)
        );
    }

    public async getFileStream(
        contentId: ContentId,
        file: string,
        user: IUser,
        rangeStart?: number,
        rangeEnd?: number
    ): Promise<ReadStream> {
        if (!(await this.fileExists(contentId, file))) {
            throw new H5pError(
                'content-file-missing',
                { file, contentId: contentId },
                404
            );
        }

        return fsExtra.createReadStream(
            path.join(this._options.contentPath, contentId, file),
            {
                start: rangeStart,
                end: rangeEnd
            }
        );
    }

    public async getMetadata(
        contentId: ContentId,
        user?: IUser
    ): Promise<IContentMetadata> {
        return new Promise((resolve, reject) => {
            this._connection.query('SELECT metadata FROM content WHERE id = ?', [contentId], function (error, results, fields){
                if (error) {
                    reject(error);
                }

                if (results.length === 0) {
                    resolve(null);
                    return;
                }

                const metadata = JSON.parse(results[0].metadata);
                resolve(metadata);
            });
        });
    }

    public async getParameters(
        contentId: ContentId,
        user?: IUser
    ): Promise<ContentParameters> {
        return new Promise((resolve, reject) => {
            this._connection.query('SELECT content FROM content WHERE id = ?', [contentId], function (error, results, fields){
                if (error) {
                    reject(error);
                }

                if (results.length === 0) {
                    resolve(null);
                    return;
                }

                const content = JSON.parse(results[0].content);
                resolve(content);
            });
        });
    }

    public async getUsage(
        library: ILibraryName
    ): Promise<{ asDependency: number; asMainLibrary: number }> {
        let asDependency = 0;
        let asMainLibrary = 0;

        const contentIds = await this.listContent();

        for (const contentId of contentIds) {
            const contentMetadata = await this.getMetadata(contentId);
            const isMainLibrary = contentMetadata.mainLibrary === library.machineName;

            if (hasDependencyOn(contentMetadata, library)) {
                if (isMainLibrary) {
                    asMainLibrary += 1;
                } else {
                    asDependency += 1;
                }
            }
        }

        return { asDependency, asMainLibrary };
    }

    public getUserPermissions(
        contentId: ContentId,
        user: IUser
    ): Promise<Permission[]> {
        return new Promise((resolve, reject) => {
            resolve([
                Permission.Delete,
                Permission.Download,
                Permission.Edit,
                Permission.Embed,
                Permission.View
            ]);
        });
    }

    public async listContent(user?: IUser): Promise<ContentId[]> {
        return new Promise((resolve, reject) => {
            this._connection.query('SELECT id FROM content WHERE metadata IS NOT NULL', function (error, results, fields){
                if (error) {
                    reject(error);
                }

                const ids = results.map((row : any) => {
                    return row.id;
                })

                resolve(ids);
            });
        });
    }

    public async listFiles(contentId: ContentId, user: IUser): Promise<string[]> {
        const contentDirectoryPath = path.join(
            this._options.contentPath,
            contentId
        );

        const absolutePaths = await globPromise(
            path.join(contentDirectoryPath, '**', '*.*'),
            {
                nodir: true
            }
        );
        return absolutePaths.map((p) => path.relative(contentDirectoryPath, p));
    }

    public sanitizeFilename?(filename: string): string {
        return sanitizeFilename(filename, 100);
    }
}