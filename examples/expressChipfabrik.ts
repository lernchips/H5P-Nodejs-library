import bodyParser from 'body-parser';
import express from 'express';
import fileUpload from 'express-fileupload';
import i18next from 'i18next';
import i18nextHttpMiddleware from 'i18next-http-middleware';
import i18nextFsBackend from 'i18next-fs-backend';
import path from 'path';

import h5pAjaxExpressRouter from '../src/adapters/H5PAjaxRouter/H5PAjaxExpressRouter';
import libraryAdministrationExpressRouter from '../src/adapters/LibraryAdministrationRouter/LibraryAdministrationExpressRouter';
import contentTypeCacheExpressRouter from '../src/adapters/ContentTypeCacheRouter/ContentTypeCacheExpressRouter';
import { IRequestWithUser } from '../src/adapters/expressTypes';

import * as H5P from '../src';
import expressRoutes from './expressRoutes';
import startPageRenderer from './startPageRenderer';
import User from './User';
import { displayIps } from './utils';

import ChipfabrikMySqlContentStorage from './chipfabrikMySqlContentStorage';

const start = async () => {
    // We use i18next to localize messages sent to the user. You can use any
    // localization library you like.
    const translationFunction = await i18next
        .use(i18nextFsBackend)
        .use(i18nextHttpMiddleware.LanguageDetector) // This will add the
        // properties language and languages to the req object.
        // See https://github.com/i18next/i18next-http-middleware#adding-own-detection-functionality
        // how to detect language in your own fashion. You can also choose not
        // to add a detector if you only want to use one language.
        .init({
            backend: {
                loadPath: 'assets/translations/{{ns}}/{{lng}}.json'
            },
            debug: process.env.DEBUG && process.env.DEBUG.includes('i18n'),
            defaultNS: 'server',
            fallbackLng: 'en',
            ns: [
                'client',
                'copyright-semantics',
                'metadata-semantics',
                'mongo-s3-content-storage',
                's3-temporary-storage',
                'server',
                'storage-file-implementations'
            ],
            preload: ['en', 'de'] // If you don't use a language detector of
            // i18next, you must preload all languages you want to use!
        });

    // Load the configuration file from the local file system
    const config = await new H5P.H5PConfig(
        new H5P.fsImplementations.JsonStorage(
            path.resolve('examples/config.json')
        )
    ).load();

    // The H5PEditor object is central to all operations of h5p-nodejs-library
    // if you want to user the editor component.
    const chipfabrikMySqlContentStorage = new ChipfabrikMySqlContentStorage({
        contentPath: path.resolve('h5p/content'),
        mysqlHost: process.env.CHIPFABRIK_HOST,
        mysqlUser: process.env.CHIPFABRIK_USER,
        mysqlPassword: process.env.CHIPFABRIK_PASS,
        mysqlDatabase: process.env.CHIPFABRIK_DATABASE
    });
    const h5pEditor = new H5P.H5PEditor(
        new H5P.fsImplementations.InMemoryStorage(), // this is a general-purpose cache
        config,
        new H5P.fsImplementations.FileLibraryStorage(path.resolve('h5p/libraries')),
        chipfabrikMySqlContentStorage,
        new H5P.fsImplementations.DirectoryTemporaryFileStorage(path.resolve('h5p/temporary-storage')),
        (key, language) => {
            return translationFunction(key, { lng: language });
        }
    );

    // The H5PPlayer object is used to display H5P content.
    const h5pPlayer = new H5P.H5PPlayer(
        h5pEditor.libraryStorage,
        h5pEditor.contentStorage,
        config
    );

    // We now set up the Express server in the usual fashion.
    const server = express();

    server.use(bodyParser.json({ limit: '500mb' }));
    server.use(
        bodyParser.urlencoded({
            extended: true
        })
    );
    server.use(
        fileUpload({
            limits: { fileSize: h5pEditor.config.maxTotalSize }
        })
    );

    // It is important that you inject a user object into the request object!
    // The Express adapter below (H5P.adapters.express) expects the user
    // object to be present in requests.
    // In your real implementation you would create the object using sessions,
    // JSON webtokens or some other means.
    server.use((req: IRequestWithUser, res, next) => {
        req.user = new User();
        next();
    });

    // The i18nextExpressMiddleware injects the function t(...) into the req
    // object. This function must be there for the Express adapter
    // (H5P.adapters.express) to function properly.
    server.use(i18nextHttpMiddleware.handle(i18next));

    // The Express adapter handles GET and POST requests to various H5P
    // endpoints. You can add an options object as a last parameter to configure
    // which endpoints you want to use. In this case we don't pass an options
    // object, which means we get all of them.
    server.use(
        h5pEditor.config.baseUrl,
        h5pAjaxExpressRouter(
            h5pEditor,
            path.resolve('h5p/core'), // the path on the local disc where the files of the JavaScript client of the player are stored
            path.resolve('h5p/editor'), // the path on the local disc where the files of the JavaScript client of the editor are stored
            undefined,
            'auto' // You can change the language of the editor here by setting
            // the language code you need here. 'auto' means the route will try
            // to use the language detected by the i18next language detector.
        )
    );

    // The expressRoutes are routes that create pages for these actions:
    // - Creating new content
    // - Editing content
    // - Saving content
    // - Deleting content
    server.use(
        h5pEditor.config.baseUrl,
        expressRoutes(
            h5pEditor,
            h5pPlayer,
            'auto' // You can change the language of the editor here by setting
            // the language code you need here. 'auto' means the route will try
            // to use the language detected by the i18next language detector.
        )
    );

    // The LibraryAdministrationExpress routes are REST endpoints that offer library
    // management functionality.
    server.use(
        `${h5pEditor.config.baseUrl}/libraries`,
        libraryAdministrationExpressRouter(h5pEditor)
    );

    // The ContentTypeCacheExpress routes are REST endpoints that allow updating
    // the content type cache manually.
    server.use(
        `${h5pEditor.config.baseUrl}/content-type-cache`,
        contentTypeCacheExpressRouter(h5pEditor.contentTypeCache)
    );

    // The startPageRenderer displays a list of content objects and shows
    // buttons to display, edit, delete and download existing content.
    server.get('/', startPageRenderer(h5pEditor));

    server.use(
        '/client',
        express.static(path.resolve('build/examples/client'))
    );

    const port = process.env.PORT || '8080';

    // For developer convenience we display a list of IPs, the server is running
    // on. You can then simply click on it in the terminal.
    displayIps(port);

    server.listen(port);
};

// We can't use await outside a an async function, so we use the start()
// function as a workaround.

start();
