var fs = require('fs');
var jsonfile = require('jsonfile');
var Cloudant = require('cloudant');
var uuid = require('node-uuid');
var s3 = require('s3');
var async = require('async');
var mv = require('mv');
var spawn = require('child_process').spawn;
var obj2gltf = require('obj2gltf');
var convert = obj2gltf.convert;
var gm = require('gm').subClass({ imageMagick: true });
var request = require('request');
var ncp = require('ncp').ncp;

var Enums = require('./app/enums.js');
var realtime = require('./app/realtime.js');
var ExifImage = require('exif').ExifImage;

//setup express endpoint to pass tests
var express = require('express');
var app = express();
var cfenv = require('cfenv');
var appEnv = cfenv.getAppEnv();

//file upload configuration
var rootDirName = "temp"
var rootDir = './' + rootDirName;
var thumbnailSize = 300;
var tileSize = 300;
var watsonAnalysisData = {};
var exifData = [];
var startTime = 0;
var ODM_MIN_ALTITIUDE = 15; //meters
var ODM_DISTRIBUTION_STEP = 5; // meters

//pull from DALLAS specifically b/c processing server and COS are both in dallas data center
var s3Client = s3.createClient({
    s3Options: {
        accessKeyId: "y2x87rRAM5nipBcrZM10",
        secretAccessKey: "yEmoe7LVGkfVJyRDEfTFdkCzSBzzDpKI4QhUE8Ek",
        endpoint: 's3-api.us-geo.objectstorage.softlayer.net',
        sslEnabled: false
    },
});
var s3Bucket = "yuma310"
    //TODO: externalize S3 credentials

// get the app environment from Cloud Foundry
var services = jsonfile.readFileSync('./config/services.json');
realtime.init(services["socket.io"]["host"])


app.get('/', function(req, res) {
    res.send("Hello World");
});

// Initialize Cloudant DB
var cloudantConfig = services.cloudantNoSQLDB[0];
var cloudant = Cloudant(cloudantConfig.credentials.url);
var db
var dbName = "jupiter"


cloudant.db.create(dbName, function(err, result) {

    if (err) {
        console.log('[db.create] ' + err.message.toString());
    }

    // Specify the database we are going to use...
    db = cloudant.db.use(dbName);

    console.log("ready for business...")
    pollForNewData();

});


function pollNext() {
    setTimeout(function() {
        pollForNewData();
    }, 1000);
}

function pollForNewData() {

    db.view('jupiter', 'propertiesForAnalysis', { limit: 2 }, function(err, body) {
        if (err) {
            realtime.emit(err.toString());
            console.log(err.toString());
            pollNext();
        } else {
            if (body.rows.length > 0) {

                var doc = body.rows[0].value;
                processDoc(doc);
            } else {
                pollNext();
            }
        }
    });
}


var currentDocument = undefined;

function processDoc(doc) {
    console.log("Processing Document: \n" + doc);
    watsonAnalysisData = {};
    exifData = [];
    startTime = new Date().getTime();

    realtime.connect(doc._id, function() {
        realtime.emit("Started Processing Document: " + doc._id);

        currentDocument = doc;
        async.waterfall([
                getUpdateStatusRequest(Enums.PropertyState.PROCESSING),
                updateDoc,
                prepareFileSystemForAnalysis,
                fetchImageRecordsForDocument,
                fetchImagesFromObjectStorage,
                processImages,
                moveOriginalToImages,
                generateOverlayImages,
                generateOverlayThumbnails,

                // cleanupObjModels,
                // generateOrthosRequest(),
                // convertModelsToWebFormats,
                // moveOriginalModels,
                // moveOverlayImages,  

                //cleanupProcessingDirectories,
                //getODMReProcessithOverlayRequest(),
                //cleanupObjModels,   
                //generateOrthosRequest(),
                //convertModelsToWebFormats,  
                //moveOverlaidModels,  
                getDelayRequest(10000), //wait to make sure file system is ready to start copying... (not sure why this is needed b/c we already got a complete event)
                uploadGeneratedModels, // upload all images and analysis to S3

                // Datawing Integration
                updateDatwing,


                getUpdateStatusRequest(Enums.PropertyState.COMPLETE),
                updateProcessingTime,
                updateDoc,
                emitCompleteEvent
            ],
            function(err, analysis) {
                if (err) {
                    //callback(err);
                } else {
                    //callback(undefined, parseData);
                }

                currentDocument = undefined;
                pollNext();
            });
    })
}

// Step 1
function updateDatwing() {
    return function(callback) {
        realtime.emit("Notify Third Party with Property "+ currentDocument._id);
        var raw_images = [];
        var watsonized_images = [];
        var count = 0;
        var images = {}

        db.view('jupiter', 'datawing-view', { key: currentDocument._id }, function(err, prop) {
            if (err) {
                res.status(404).send(err.toString());
                return;
            }

            db.find({ selector: { property: currentDocument._id } }, function(er, body) {
                if (er) {
                    res.status(500).send(er.toString());
                    throw er;
                }

                body.docs.forEach(function(elem) {
                    raw_images.push(elem.path);
                    wi = elem.path.replace("original", "data-overlay");
                    watsonized_images.push(wi);
                    count++;
                });

                if(count == body.docs.length) {
                    prop.rows[0].value.images = {raw_images: raw_images, watsonized_images: watsonized_images };
                    console.log(prop.rows[0].value);
                    callback();
                }
            });
        });
    }
}

function getDelayRequest(delay) {
    return function(callback) {
        realtime.emit("Intentional Delay: " + delay + "ms");
        setTimeout(function() {
            realtime.emit("Intentional Delay Complete");
            callback();
        })

    }
}

function getUpdateStatusRequest(status) {
    return function(callback) {
        realtime.emit("Updating Document Status: " + status);
        currentDocument.status = status;
        callback();
    }
}

function prepareFileSystemForAnalysis(callback) {
    realtime.emit("Preparing file system for analysis...");
    recursiveDeleteFolderSync(rootDir);
    if (!fs.existsSync(rootDir)) {
        fs.mkdirSync(rootDir);
    }
    if (currentDocument && currentDocument._id) {
        var documentDirectory = rootDir + "/" + currentDocument._id;
        if (!fs.existsSync(documentDirectory)) {
            fs.mkdirSync(documentDirectory);
        }
    }
    callback(null);
}

function fetchImageRecordsForDocument(callback) {
    realtime.emit("Fetching image records from Cloudant for " + currentDocument._id);
    db.find({ selector: { property: currentDocument._id } }, function(err, body) {
        if (err) {
            realtime.emit(err.toString());
            throw er;
        }
        realtime.emit("Retrieved " + body.docs.length + " image records.");
        callback(null, body.docs)
    });
}

function fetchImagesFromObjectStorage(images, callback) {


    if (currentDocument.primaryImage == "" || currentDocument.primaryImage == undefined && images.length > 0) {
        currentDocument.primaryImage = images[0].path;
    }

    var imageDownloadRequests = []
    for (var x = 0; x < images.length; x++) {

        var s3Path = images[x].path.toString();
        var downloadRequest = getS3DownloadCallback(s3Path);
        imageDownloadRequests.push(downloadRequest);
    }

    async.parallel(imageDownloadRequests,
        function(err, analysis) {
            if (err) {
                callback(err);
            } else {
                callback(undefined);
            }
        });
}

function getS3DownloadCallback(path) {
    return function(cb) {
        performS3Download(path, function(err) {
            cb(err);
        });
    }
}

function performS3Download(s3Path, callback) {

    var localPath = rootDir + "/" + s3Path;

    var params = {
        localFile: localPath,
        s3Params: {
            Bucket: s3Bucket,
            Key: s3Path
        },
    };

    var downloader = s3Client.downloadFile(params);
    downloader.on('error', function(err) {
        console.error("unable to download:", err.stack);
        realtime.emit("ERROR: Unable to download to Analytics server from COS-S3: " + err.toString());
        callback(err);
    });
    downloader.on('progress', function() {
        console.log("progress", downloader.progressAmount, downloader.progressTotal);
    });
    downloader.on('end', function() {
        realtime.emit("Download to Analytics server from COS-S3 Complete: " + localPath);
        callback(null);
    });
}



function processImages(callback) {

    var processingTasks = [];

    //processingTasks.push(performODMProcessing)
    processingTasks.push(performVisualProcessing)

    async.parallel(processingTasks,
        function(err, analysis) {
            if (err) {
                callback(err);
            } else {
                callback(undefined);
            }
        });
}

function performODMProcessing(callback) {

    async.waterfall([prepareToCopyImagesForODMAnalysisRequest(), copyImagesForODMAnalysisRequest(), getODMProcessingRequest()],
        function(err, analysis) {
            if (err) {
                callback(err);
            } else {
                callback(undefined);
            }
        });
}

function prepareToCopyImagesForODMAnalysisRequest() {
    return function(callback) {


        realtime.emit("ready to copy images for ODM model reconstruction...")

        //get all of the contents of the /original directory and move (if within criteria)
        var originalRoot = rootDir + "/" + currentDocument._id + "/original";
        var imagesRoot = originalRoot.replace("/original", "/images");
        var moveRequests = [];
        var fetchExifRequests = [];
        if (fs.existsSync(originalRoot)) {

            if (!fs.existsSync(imagesRoot)) {
                fs.mkdirSync(imagesRoot);
            }

            fs.readdirSync(originalRoot).forEach(function(file, index) {
                var curPath = originalRoot + "/" + file;
                if (fs.lstatSync(curPath).isDirectory()) {
                    // ignore (for now... this should not contain subfolders)
                } else {
                    // get exif data
                    fetchExifRequests.push(fetchImageExifRequest(curPath))
                        //moveRequests.push(moveOnImageExifRequest(curPath, "/original", "/images"))
                }
            });
        }

        if (fetchExifRequests.length > 0) {
            async.waterfall(fetchExifRequests,
                function(err) {
                    if (err) {
                        callback(err);
                    } else {
                        callback(undefined);
                    }
                });
        } else {
            callback();
        }
    }
}

function fetchImageExifRequest(path, originalPath, targetPath) {
    return function(callback) {
        realtime.emit("fetching EXIF data for " + path)

        try {
            new ExifImage({ image: path }, function(error, exif) {
                if (error)
                    callback('Error: ' + error.message);
                else {
                    exifData.push({
                        path: path,
                        exif: exif
                    });
                    callback();
                }
            });
        } catch (error) {
            callback('Error: ' + error.message);
        }
    }
}



function copyImagesForODMAnalysisRequest() {
    return function(callback) {
        //analyze exif data to determine range of image altitudes
        var exifRange = analyzeEXIF()
        watsonAnalysisData.EXIF = {
            raw: exifData,
            range: exifRange
        }

        var copyRequests = [];

        //copy images based on altitude within range
        for (var x = 0; x < exifData.length; x++) {
            var imageData = exifData[x];
            if (imageData.exif.gps) {
                var alt = imageData.exif.gps.GPSAltitude;
                var agl = alt - exifRange.min;

                //if above minimum AGL (above ground level) altitude, then include in 3d reconstruction
                //agl is esimated by calculating min image height gps
                if (agl >= ODM_MIN_ALTITIUDE) {
                    var source = imageData.path;
                    var target = source.replace("/original", "/images")
                    var copyRequest = copyDirectoryRequest(target, source);
                    copyRequests.push(copyRequest);
                }
            }
        }

        async.waterfall(copyRequests, function(err) {
            if (err) {
                callback(err);
            } else {
                callback(undefined);
            }
        });
    }
}

function analyzeEXIF() {
    realtime.emit("Analyzing Image EXIF Values");
    var exifRange = {
        distribution: {}
    };

    for (var x = 0; x < exifData.length; x++) {
        var exif = exifData[x].exif;
        var gps = exif.gps;
        if (gps != undefined) {
            if (exifRange.min == undefined) {
                exifRange.min = gps.GPSAltitude;
            } else {
                exifRange.min = Math.min(exifRange.min, gps.GPSAltitude);
            }
            if (exifRange.max == undefined) {
                exifRange.max = gps.GPSAltitude;
            } else {
                exifRange.max = Math.max(exifRange.max, gps.GPSAltitude);
            }

            var floor = Math.floor(gps.GPSAltitude / ODM_DISTRIBUTION_STEP) * ODM_DISTRIBUTION_STEP;
            var key = floor.toString();
            if (exifRange.distribution[key] == undefined) {
                exifRange.distribution[key] = 0
            } else {
                exifRange.distribution[key]++;
            }
        }
    }

    console.log(exifRange)

    return exifRange;
}







function getODMProcessingRequest() {
    return function(callback) {

        if (currentDocument && currentDocument._id) {

            var processingPath = __dirname + "/" + rootDirName + "/" + currentDocument._id;

            var inactivityTimeout = 0;
            var iterations = 0;
            var resetInactivity = function() {

                clearTimeout(inactivityTimeout);
                inactivityTimeout = setTimeout(function() {
                    iterations++;
                    var output = "";
                    for (var x = 0; x < iterations; x++) {
                        output += "."
                    }
                    if (iterations > 20) {
                        iterations = 0;
                    }
                    realtime.emit(output);
                    resetInactivity();
                }, 1000);
            }

            var command = services.odm.run_command + " " + services.odm.path_parameter_prefix + " " + processingPath;
            realtime.emit("Invoke ODM child process: " + command);

            var childProcess = spawn(services.odm.run_command, [
                services.odm.path_parameter_prefix, processingPath,
                "--end-with", "odm_georeferencing"
            ]);

            var childProcessError = undefined;

            childProcess.stdout.on('data', function(data) {
                //console.log(`stdout: ${data}`);
                realtime.emit(`stdout: ${data}`);
                resetInactivity();
            });

            childProcess.stderr.on('data', function(data) {
                //console.log(`stderr: ${data}`);
                realtime.emit(`stderr: ${data}`);
                resetInactivity();
            });

            childProcess.on('error', function(err) {
                //console.log(`child process exited with code ${code}`);
                realtime.emit(`ERROR: ${err.toString()}`);
                childProcessError = err;
                resetInactivity();
            });

            childProcess.on('close', function(code) {
                //console.log(`child process exited with code ${code}`);
                clearTimeout(inactivityTimeout);
                realtime.emit(`child process exited with code ${code}`);

                callback(childProcessError);

            });

        } else {
            callback("Current document does not exist.");
        }
    }
}

function cleanupProcessingDirectories(callback) {
    var directoriesToRemove = ["resize", "odm_texturing", "odm_georeferencing", "odm_orthophoto"];
    for (var x = 0; x < directoriesToRemove.length; x++) {
        var dir = directoriesToRemove[x];

        var targetDir = rootDir + "/" + currentDocument._id + "/" + dir;
        realtime.emit("Deleting working directory: " + targetDir);
        recursiveDeleteFolderSync(targetDir)
    }
    callback();
}

function getODMReProcessithOverlayRequest() {
    return function(callback) {

        if (currentDocument && currentDocument._id) {

            var reprocessingSteps = ["resize", "odm_texturing", "odm_georeferencing", "odm_orthophoto"];
            var reprocessingRequests = [];

            for (var x = 0; x < reprocessingSteps.length; x++) {
                var step = reprocessingSteps[x];
                reprocessingRequests.push(getODMProcessingStepRequest(step));
            }


            async.waterfall(reprocessingRequests,
                function(err, analysis) {
                    callback(err);
                });

        } else {
            callback("Current document does not exist.");
        }
    }
}

function generateOrthosRequest() {
    return function(callback) {

        if (currentDocument && currentDocument._id) {

            var reprocessingSteps = ["odm_orthophoto"];
            var reprocessingRequests = [];

            for (var x = 0; x < reprocessingSteps.length; x++) {
                var step = reprocessingSteps[x];
                reprocessingRequests.push(getODMProcessingStepRequest(step));
            }


            async.waterfall(reprocessingRequests,
                function(err, analysis) {
                    callback(err);
                });

        } else {
            callback("Current document does not exist.");
        }
    }
}

function getODMProcessingStepRequest(step) {
    return function(callback) {

        var processingPath = __dirname + "/" + rootDirName + "/" + currentDocument._id;
        var inactivityTimeout = 0;
        var iterations = 0;
        var resetInactivity = function() {

            clearTimeout(inactivityTimeout);
            inactivityTimeout = setTimeout(function() {
                iterations++;
                var output = "";
                for (var x = 0; x < iterations; x++) {
                    output += "."
                }
                if (iterations > 20) {
                    iterations = 0;
                }
                realtime.emit(output);
                resetInactivity();
            }, 1000);
        }

        var command = services.odm.run_command + " -r " + step;
        realtime.emit("Invoke ODM child process: " + command);

        var childProcess = spawn(services.odm.run_command, [
            services.odm.path_parameter_prefix, processingPath,
            services.odm.rerun_parameter_prefix, step,
        ]);

        var childProcessError = undefined;

        childProcess.stdout.on('data', function(data) {
            //console.log(`stdout: ${data}`);
            realtime.emit(`stdout: ${data}`);
            resetInactivity();
        });

        childProcess.stderr.on('data', function(data) {
            //console.log(`stderr: ${data}`);
            realtime.emit(`stderr: ${data}`);
            resetInactivity();
        });

        childProcess.on('error', function(err) {
            //console.log(`child process exited with code ${code}`);
            realtime.emit(`ERROR: ${err.toString()}`);
            childProcessError = err;
            resetInactivity();
        });

        childProcess.on('close', function(code) {
            //console.log(`child process exited with code ${code}`);
            clearTimeout(inactivityTimeout);
            realtime.emit(`child process exited with code ${code}`);

            callback(childProcessError);

        });
    }
}

function cleanupObjModels(callback) {
    var objFiles = [
        __dirname + "/" + rootDirName + "/" + currentDocument._id + '/odm_texturing/odm_textured_model_geo.obj',
        __dirname + "/" + rootDirName + "/" + currentDocument._id + '/odm_texturing/odm_textured_model_geo.mtl',
        __dirname + "/" + rootDirName + "/" + currentDocument._id + '/odm_texturing/odm_textured_model.obj',
        __dirname + "/" + rootDirName + "/" + currentDocument._id + '/odm_texturing/odm_textured_model.mtl'
    ];

    console.log(objFiles);

    var processingRequests = [];

    for (var x = 0; x < objFiles.length; x++) {
        processingRequests.push(getModelCleanupRequest(objFiles[x]));
    }

    async.waterfall(processingRequests, function(err) {
        callback(err);
    });
}

function getModelCleanupRequest(path) {
    return function(callback) {
        realtime.emit("removing unnecessary textures from model: " + path);
        var data = fs.readFile(path, 'utf8', function(err, data) {
            if (err) {
                callback(err)
                return;
            }

            //console.log('OK: ' + filename);
            //console.log(data)
            var dataString = data.toString();
            var offendingTexture = "non_visible_faces_texture";
            var count = (data.match(/non_visible_faces_texture/g) || []).length;
            console.log(count + " mesh(es) to remove");
            var startIndex = dataString.indexOf(offendingTexture);
            if (startIndex > 0) {
                //back up to the last usemtl at the beginning of the offedning mesh

                var startTargetMatch = "usemtl";
                var endTargetMatch = "faces in mesh";
                if (path.indexOf(".mtl") >= 0) {

                    startTargetMatch = "newmtl";
                    endTargetMatch = "non_visible_faces_texture.jpg";
                }

                startIndex = dataString.lastIndexOf(startTargetMatch, startIndex);

                //end at the end of the mesh
                var endIndex = dataString.indexOf(endTargetMatch, startIndex);
                endIndex = dataString.lastIndexOf("#", endIndex);

                dataString = dataString.substring(0, startIndex) + dataString.substring(endIndex);

                dataString = dataString.replace(/vt 0\.25 0\.25\n/g, "")
                dataString = dataString.replace(/vt 0\.25 0\.75\n/g, "")
                dataString = dataString.replace(/vt 0\.75 0\.75\n/g, "")


                //console.log(dataString);
                fs.writeFile(path, dataString, function(err) {
                    if (err) {
                        realtime.emit("ERROR:" + err.toString());
                        callback(err);
                    } else {
                        realtime.emit("Successfully trimmed " + path);
                        callback()
                    }
                });
            } else {
                callback()
            }
        });
    }
}



function convertModelsToWebFormats(callback) {

    var inactivityTimeout = 0;
    var iterations = 0;
    var resetInactivity = function() {

        clearTimeout(inactivityTimeout);
        inactivityTimeout = setTimeout(function() {
            iterations++;
            var output = "";
            for (var x = 0; x < iterations; x++) {
                output += "."
            }
            if (iterations > 20) {
                iterations = 0;
            }
            realtime.emit(output);
            resetInactivity();
        }, 1000);
    }


    var lasFile = __dirname + "/" + rootDirName + "/" + currentDocument._id + '/odm_georeferencing/odm_georeferenced_model.ply.las';
    var outputLocation = __dirname + "/" + rootDirName + "/" + currentDocument._id + '/potree/';

    var command = services.potree.run_command + " " + lasFile + " " + services.potree.output_parameter.replace("{output_directory}", outputLocation) + " " + services.potree.page_generator_parameter;
    realtime.emit("Invoke POTREE child process: " + command);

    var childProcess = spawn(services.potree.run_command, [
        lasFile,
        services.potree.output_parameter, outputLocation,
        services.potree.page_generator_parameter, services.potree.page_generator_name
    ]);

    var childProcessError = undefined;

    childProcess.stdout.on('data', function(data) {
        //console.log(`stdout: ${data}`);
        realtime.emit(`stdout: ${data}`);
        resetInactivity();
    });

    childProcess.stderr.on('data', function(data) {
        //console.log(`stderr: ${data}`);
        realtime.emit(`stderr: ${data}`);
        resetInactivity();
    });

    childProcess.on('error', function(err) {
        //console.log(`child process exited with code ${code}`);
        realtime.emit(`ERROR: ${err.toString()}`);
        childProcessError = err;
        resetInactivity();
    });

    childProcess.on('close', function(code) {
        //console.log(`child process exited with code ${code}`);
        clearTimeout(inactivityTimeout);
        realtime.emit(`child process exited with code ${code}`);

        callback(childProcessError);
    });
}



function copyImagesForODMAnalysis(callback) {
    realtime.emit("Moving generated models to subfolders...");
    var targetDir = rootDir + "/" + currentDocument._id + "/odm-original"
    copyDirectoriesToTarget(targetDir, callback);
}


function moveOriginalModels(callback) {
    realtime.emit("Moving generated models to subfolders...");
    var targetDir = rootDir + "/" + currentDocument._id + "/odm-original"
    copyDirectoriesToTarget(targetDir, callback);
}

function moveOverlaidModels(callback) {
    realtime.emit("Moving generated overlay models to subfolders...");
    var targetDir = rootDir + "/" + currentDocument._id + "/odm-overlay"
    copyDirectoriesToTarget(targetDir, callback);
}

function copyDirectoriesToTarget(target, callback) {

    if (!fs.existsSync(target)) {
        fs.mkdirSync(target);
    }

    var copyRequests = [];

    var directoriesToCopy = ["odm_georeferencing", "odm_orthophoto", "potree", "odm_meshing", "odm_texturing"];
    for (var x = 0; x < directoriesToCopy.length; x++) {
        var dir = directoriesToCopy[x];

        var sourceDir = rootDir + "/" + currentDocument._id + "/" + dir
        var currentTarget = target + "/" + dir;

        if (!fs.existsSync(currentTarget)) {
            fs.mkdirSync(currentTarget);
        }

        if (fs.existsSync(sourceDir)) {
            copyRequests.push(copyDirectoryRequest(currentTarget, sourceDir));
        }
    }

    async.waterfall(copyRequests,
        function(err) {
            realtime.emit("Finished moving subfolders...");
            if (err) {
                realtime.emit(err);
            }
            callback(err);
        });
}

function copyDirectoryRequest(targetDir, sourceDir) {
    return function(callback) {
        realtime.emit("Moving Directory FROM: " + sourceDir + " TO: " + targetDir)
        ncp(sourceDir, targetDir, function(err) {
            if (err) {
                realtime.emit(err);
            }
            callback(err);
        });
    }
}



function moveOriginalToImages(callback) {
    realtime.emit("Moving 'original' to 'images'...");
    var sourceDir = rootDir + "/" + currentDocument._id + "/original"
    var targetDir = rootDir + "/" + currentDocument._id + "/images"

    mv(sourceDir, targetDir, function(err) {
        realtime.emit("move images complete");
        callback(err);
    });
}

function moveImagesToOriginal(callback) {
    realtime.emit("Moving 'images' to 'original'...");
    var sourceDir = rootDir + "/" + currentDocument._id + "/images"
    var targetDir = rootDir + "/" + currentDocument._id + "/original"

    mv(sourceDir, targetDir, function(err) {
        realtime.emit("move images complete");
        callback(err);
    });
}

function moveOverlayImages(callback) {
    realtime.emit("Moving 'data-overlay' to 'images'...");
    var sourceDir = rootDir + "/" + currentDocument._id + "/data-overlay"
    var targetDir = rootDir + "/" + currentDocument._id + "/images"

    mv(sourceDir, targetDir, function(err) {
        realtime.emit("move images complete");
        callback(err);
    });
}



function uploadGeneratedModels(callback) {
    //odm-original //odm-overlay
    var folders = ["thumbnail", "analysis", "data-overlay", "data-overlay-thumbnail"];
    var uploadRequests = [];

    for (var x = 0; x < folders.length; x++) {
        var folder = folders[x];
        var modelFolder = rootDir + "/" + currentDocument._id + "/" + folder;
        var requests = recursiveUploadToS3(modelFolder);
        uploadRequests = uploadRequests.concat(requests);
    }

    console.log("Uploading to S3")

    async.parallel(uploadRequests,
        function(err, analysis) {
            if (err) {
                callback(err);
            } else {
                callback(undefined);
            }
        });
}


function recursiveUploadToS3(path) {
    var uploadRequests = [];
    if (fs.existsSync(path)) {
        fs.readdirSync(path).forEach(function(file, index) {
            var curPath = path + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) {
                // recurse
                uploadRequests = uploadRequests.concat(recursiveUploadToS3(curPath));
            } else {
                // upload
                uploadRequests.push(generateS3UploadRequest(curPath));
            }
        });
    }
    return uploadRequests;
}

function generateS3UploadRequest(path) {

    var replacePath = rootDir + "/";
    var s3Path = path.replace(replacePath, "");

    return function(callback) {
        var params = {
            localFile: path,
            s3Params: {
                Bucket: "yuma310",
                Key: s3Path,
                ACL: 'public-read'
            },
        };
        var uploader = s3Client.uploadFile(params);
        uploader.on('error', function(err) {
            console.error("unable to upload:", err.stack);
            callback(err);
        });
        uploader.on('progress', function() {
            //console.log("progress", uploader.progressMd5Amount, uploader.progressAmount, uploader.progressTotal);
        });
        uploader.on('end', function() {
            console.log("done uploading to s3");
            realtime.emit("File Saved in Object Storage: " + s3Path);
            callback(undefined);
        });
    };
}

function updateProcessingTime(callback) {
    var doc = currentDocument;
    var now = new Date().getTime();
    currentDocument.processingTimeMS = now - startTime;
    callback ();
}

function updateDoc(callback) {
    var doc = currentDocument;

    db.insert(doc, function(err, body, header) {
        if (err) {
            realtime.emit("ERROR:" + err.toString());
        } else {
            realtime.emit("Updated Document in Cloudant");
            currentDocument.rev = body.rev;
            currentDocument._rev = body.rev;
        }
        callback(err);
    });
}


function emitCompleteEvent(callback) {
    var now = new Date();
    realtime.emit("PROCESING COMPLETE.");
    realtime.emit(now.toISOString(), "analyticsComplete");
    callback();
}




function performVisualProcessing(callback) {
    if (currentDocument && currentDocument._id) {

        var processingTasks = [];

        processingTasks.push(generateThumbnails)
        if (currentDocument.omitWatsonAnalysis != true) {
            processingTasks.push(generateTiles)
            processingTasks.push(watsonAnalysis)
        }
        processingTasks.push(saveWatsonAnalysisToDisk)
            // processingTasks.push(generateOverlayImages)
            // processingTasks.push(generateOverlayThumbnails)

        async.waterfall(processingTasks,
            function(err, analysis) {
                if (err) {
                    callback(err);
                } else {
                    callback(undefined);
                }
            });


    } else {
        callback("Current document does not exist.");
    }
}

function generateThumbnails(callback) {
    realtime.emit("generating image thumbnails")

    //get all of the contents of the /original directory and generate images

    var imagesRoot = rootDir + "/" + currentDocument._id + "/original";
    var thumbnailsRoot = imagesRoot.replace("/original", "/thumbnail");
    var thumbnailRequests = [];
    if (fs.existsSync(imagesRoot)) {

        if (!fs.existsSync(thumbnailsRoot)) {
            fs.mkdirSync(thumbnailsRoot);
        }

        fs.readdirSync(imagesRoot).forEach(function(file, index) {
            var curPath = imagesRoot + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) {
                // ignore (for now... this should not contain subfolders)
            } else {
                // request to generate thumbnail
                thumbnailRequests.push(generateIndividualThumbnailRequest(curPath, "/original", "/thumbnail"))
            }
        });
    }

    if (thumbnailRequests.length > 0) {
        async.waterfall(thumbnailRequests,
            function(err) {
                if (err) {
                    callback(err);
                } else {
                    callback(undefined);
                }
            });
    } else {
        callback();
    }
}

function generateIndividualThumbnailRequest(path, originalPath, targetPath) {
    return function(callback) {
        realtime.emit("generating thumbnail for " + path)
        var thumbnailPath = path.replace(originalPath, targetPath)
        var image = gm(path);

        //first generate thumbnail
        image
            .resize(thumbnailSize, thumbnailSize)
            .write(thumbnailPath, function(err) {
                realtime.emit("saved thumbnail at " + thumbnailPath)
                callback(err);
            });


    }
}



function generateTiles(callback) {
    realtime.emit("generating image tiles")

    //get all of the contents of the /images directory and generate images

    var imagesRoot = rootDir + "/" + currentDocument._id + "/original";
    var tilesRoot = imagesRoot.replace("/original", "/tiles");
    var tilesRequests = [];
    if (fs.existsSync(imagesRoot)) {

        if (!fs.existsSync(tilesRoot)) {
            fs.mkdirSync(tilesRoot);
        }

        fs.readdirSync(imagesRoot).forEach(function(file, index) {
            var curPath = imagesRoot + "/" + file;

            if (fs.lstatSync(curPath).isDirectory()) {
                // ignore (for now... this should not contain subfolders)
            } else {
                // request to generate thumbnail
                tilesRequests.push(generateTilesForImageRequest(curPath, tilesRoot))
            }
        });
    }

    if (tilesRequests.length > 0) {
        async.waterfall(tilesRequests,
            function(err) {
                if (err) {
                    callback(err);
                } else {
                    callback();
                }
            });
    } else {
        callback();
    }
}


function parseFileName(path) {
    var tokens = path.split("/");
    return tokens[tokens.length - 1];
}

function generateTilesForImageRequest(path, tilesRoot) {
    return function(callback) {
        generateTilesForImage(path, tilesRoot, function(err, parseData) {

            if (err) {
                callback(err);
            } else {
                var fileName = parseFileName(path);
                watsonAnalysisData[fileName] = parseData;
                callback();
            }
        })
    }
}

function generateTilesForImage(path, tilesRoot, callback) {

    var imageSize = {};
    var parseData = {};

    var totalRequests = 0;
    var completedRequests = 0;

    var fileName = parseFileName(path);
    var tilesDir = tilesRoot + "/" + fileName;

    if (!fs.existsSync(tilesDir)) {
        fs.mkdirSync(tilesDir);
    }

    var image = gm(path)
        .size(function(err, size) {

            if (err) {
                callback(err);
                return;
            }


            imageSize = size;

            var cols = Math.ceil(imageSize.width / tileSize);
            var rows = Math.ceil(imageSize.height / tileSize);

            parseData.imageWidth = size.width;
            parseData.imageHeight = size.height;
            parseData.dimensions = {
                cols: cols,
                rows: rows
            }

            parseData.tiles = [];

            var command = '/usr/bin/convert ' + path + ' -crop ' + tileSize + 'x' + tileSize + ' -set filename:tile "%[fx:page.x]_%[fx:page.y]" +repage +adjoin "' + tilesDir + '/tile_%[filename:tile].jpg"';
            realtime.emit("Invoke: " + command);


            var childProcess = spawn(services.imagemagick.run_command, [
                path,
                services.imagemagick.crop_prefix, tileSize + 'x' + tileSize,
                services.imagemagick.set_prefix, services.imagemagick.set_filename, services.imagemagick.set_filename_format,
                services.imagemagick.repage,
                services.imagemagick.adjoin, tilesDir + services.imagemagick.tilename_suffix
            ]);

            var childProcessError = undefined;

            childProcess.stdout.on('data', function(data) {
                realtime.emit(`stdout: ${data}`);
            });

            childProcess.stderr.on('data', function(data) {
                realtime.emit(`stderr: ${data}`);
            });

            childProcess.on('error', function(err) {
                realtime.emit(`ERROR: ${err.toString()}`);
                childProcessError = err;
            });

            childProcess.on('close', function(code) {
                realtime.emit(`child process exited with code ${code}`);

                if (code == 0) {
                    for (var r = 0; r < rows; r++) {
                        //for (var c=0; c<cols; c++) {

                        if (parseData.tiles[r] == undefined) {
                            parseData.tiles[r] = [];
                        }

                        //loop over columns
                        for (var c = 0; c < cols; c++) {

                            if (parseData.tiles[r][c] == undefined) {
                                parseData.tiles[r][c] = {};
                            }

                            var x = c * tileSize;
                            var y = r * tileSize;
                            var output = tilesDir + "/tile_" + x + "_" + y + ".jpg";

                            parseData.tiles[r][c].path = output;
                            parseData.tiles[r][c].size = {
                                width: Math.min(tileSize, parseData.imageWidth - x),
                                height: Math.min(tileSize, parseData.imageHeight - y)
                            }
                        }
                    }
                }

                callback(childProcessError, parseData);
            });

        });



}

function _generateTilesForImage(path, tilesRoot, callback) {

    var imageSize = {};
    var parseData = {};

    var totalRequests = 0;
    var completedRequests = 0;

    var fileName = parseFileName(path);
    var tilesDir = tilesRoot + "/" + fileName;

    if (!fs.existsSync(tilesDir)) {
        fs.mkdirSync(tilesDir);
    }

    var image = gm(path)
        .size(function(err, size) {

            if (!err) {
                imageSize = size;

                var cols = Math.ceil(imageSize.width / tileSize);
                var rows = Math.ceil(imageSize.height / tileSize);

                parseData.imageWidth = size.width;
                parseData.imageHeight = size.height;
                parseData.dimensions = {
                    cols: cols,
                    rows: rows
                }

                parseData.tiles = [];

                var tileRequests = []

                //loop over rows
                for (var r = 0; r < rows; r++) {
                    //for (var c=0; c<cols; c++) {

                    if (parseData.tiles[r] == undefined) {
                        parseData.tiles[r] = [];
                    }

                    //loop over columns
                    for (var c = 0; c < cols; c++) {

                        if (parseData.tiles[r][c] == undefined) {
                            parseData.tiles[r][c] = {};
                        }

                        var x = c * tileSize;
                        var y = r * tileSize;
                        var output = tilesDir + "/tile_" + x + "_" + y + ".jpg";

                        var writeImage = function(input, output, x, y, col, row, writeImageCallback) {
                            realtime.emit("cropping image at x: " + x + " y:" + y);
                            totalRequests++;

                            gm(input)
                                .crop(tileSize, tileSize, x, y)
                                .write(output, function(err) {
                                    if (err) {
                                        realtime.emit("writing image error: " + err.toString())
                                    } else {

                                        realtime.emit("wrote image at " + output);

                                        parseData.tiles[row][col].path = output;

                                        gm(output).size(function(err, size) {

                                            if (!err) {
                                                parseData.tiles[row][col].size = size;
                                            }
                                            completedRequests++;
                                            writeImageCallback();
                                        });
                                    }
                                });
                        }

                        function wrapRequestToProtectScope(input, output, x, y, col, row, writeImageCallback) {
                            realtime.emit("QUEUEING", input, output, x, y, col, row)
                            tileRequests.push(function(asyncCallback) {
                                realtime.emit("PROCESSING", input, output, x, y, col, row)
                                writeImage(input, output, x, y, col, row, function() {
                                    asyncCallback(null);
                                })
                            });
                        }

                        wrapRequestToProtectScope(path, output, x, y, c, r);
                    }
                }

                async.waterfall(tileRequests,
                    function(err, analysis) {
                        if (err) {
                            callback(err);
                        } else {
                            callback(undefined, parseData);
                        }
                    });
            }

        });
}

function watsonAnalysis(callback) {
    var analysisRequests = [];
    for (var key in watsonAnalysisData) {
        analysisRequests.push(analysisRequest(key))
    }

    async.waterfall(analysisRequests,
        function(err) {
            callback(err);
        });
}

function analysisRequest(key) {
    return function(callback) {
        var imageData = watsonAnalysisData[key]
        analyzeTilesForImage(key, imageData, function(updatedData) {
            watsonAnalysisData[key] = updatedData;

            realtime.emit("watson analyzed: " + key);
            callback();
        });
    }
}

function analyzeTilesForImage(key, imageData, callback) {
    //realtime.emit("performing analysis on images...")

    var totalAnalysisRequests = 0;
    var completeAnalysisRequests = 0;

    if (imageData.tiles) {
        //loop over cols
        for (var r = 0; r < imageData.tiles.length; r++) {

            //loop over rows
            for (var c = 0; c < imageData.tiles[r].length; c++) {

                var image = imageData.tiles[r][c];
                //realtime.emit(key + ": analyzing image: " + image.path);

                var analyze = function(image) {
                    totalAnalysisRequests++;

                    var fileName = image.path;
                    var analysis = {}

                    fs.createReadStream(fileName).pipe(
                        request({
                                method: "POST",
                                url: "https://gateway-a.watsonplatform.net" +
                                    "/visual-recognition/api/v3/classify" +
                                    "?api_key=" + services.watson_vr.key +
                                    "&version=2016-05-20&threshold=0.0&owners=me,IBM&classifier_ids=" + services.watson_vr.classifier,
                                headers: {
                                    'Content-Length': fs.statSync(fileName).size
                                },
                                json: true
                            },
                            function(err, response, body) {
                                completeAnalysisRequests++;
                                if (err) {
                                    realtime.emit(key + ": Image Classifier", err);
                                    analysis = {
                                        error: err
                                    }
                                } else {
                                    //realtime.emit(key + ": Classified: " + completeAnalysisRequests + " of " + totalAnalysisRequests)
                                    analysis = body;
                                }
                                image.analysis = analysis;

                                if (completeAnalysisRequests == totalAnalysisRequests) {
                                    callback(imageData);
                                }
                            }))
                }

                analyze(image);

            }
        }
    } else {
        realtime.emit("No tiles to process for key:" + key);
        callback();
    }

}

function saveWatsonAnalysisToDisk(callback) {
    realtime.emit("saving watson analysis results")
    var folder = rootDir + "/" + currentDocument._id + "/analysis/";
    var savePath = rootDir + "/" + currentDocument._id + "/analysis/analysis.json";

    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder);
    }
    watsonAnalysisData.tileSize = tileSize;
    var data = JSON.stringify(watsonAnalysisData);
    fs.writeFile(savePath, data, function(err) {
        callback(err);
    });
}



function generateOverlayImages(callback) {
    realtime.emit("generating image classification overlay composite")


    var imagesRoot = rootDir + "/" + currentDocument._id + "/images";
    var dataOverlayRoot = imagesRoot.replace("/images", "/data-overlay");
    var requests = [];
    if (fs.existsSync(imagesRoot)) {

        if (!fs.existsSync(dataOverlayRoot)) {
            fs.mkdirSync(dataOverlayRoot);
        }

        fs.readdirSync(imagesRoot).forEach(function(file, index) {
            var curPath = imagesRoot + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) {
                // ignore (for now... this should not contain subfolders)
            } else {
                // request to generate thumbnail
                requests.push(generateImageWithOverlayDataRequest(curPath))
            }
        });
    }

    if (requests.length > 0) {
        async.waterfall(requests,
            function(err) {
                if (err) {
                    callback(err);
                } else {
                    callback(undefined);
                }
            });
    } else {
        callback();
    }
}



function generateImageWithOverlayDataRequest(path) {
    return function(callback) {
        realtime.emit("generating overlay data for " + path)

        var fileName = parseFileName(path);
        var overlayPath = path.replace("/images", "/data-overlay");
        var imageData = watsonAnalysisData[fileName];
        var image = gm(path);

        var rows = imageData.tiles;

        //rows
        for (var r = 0; r < rows.length; r++) {
            var cols = rows[r]
                //cols
            for (var c = 0; c < cols.length; c++) {
                var cell = cols[c];
                var x = c * tileSize;
                var y = r * tileSize;
                var w = cell.size.width;
                var h = cell.size.height;

                var color = "rgba(255,255,255,0.3)";
                var score = getAnalysisScore(cell) * 100;
                if (score >= 20 && score < 30) {
                    color = "rgba(255,255,117,0.65)";
                } else if (score >= 30 && score < 5) {
                    color = "rgba(255,135,0,0.75)";
                } else if (score >= 5) {
                    color = "rgba(255,0,0,0.8)";
                }

                image
                    .stroke("rgba(0,0,0,0.25)", 1)
                    .fill(color)
                    .drawRectangle(x, y, x + w, y + h);
            }
        }
        image
            .write(overlayPath, function(err) {
                realtime.emit("saved generated overlay data at " + overlayPath)
                callback(err);
            });


    }
}

function generateOverlayThumbnails(callback) {
    realtime.emit("generating overlay image thumbnails")

    var imagesRoot = rootDir + "/" + currentDocument._id + "/data-overlay";
    var thumbnailsRoot = imagesRoot.replace("/data-overlay", "/data-overlay-thumbnail");
    var thumbnailRequests = [];
    if (fs.existsSync(imagesRoot)) {

        if (!fs.existsSync(thumbnailsRoot)) {
            fs.mkdirSync(thumbnailsRoot);
        }

        fs.readdirSync(imagesRoot).forEach(function(file, index) {
            var curPath = imagesRoot + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) {
                // ignore (for now... this should not contain subfolders)
            } else {
                // request to generate thumbnail
                thumbnailRequests.push(generateIndividualThumbnailRequest(curPath, "/data-overlay", "/data-overlay-thumbnail"))
            }
        });
    }

    if (thumbnailRequests.length > 0) {
        async.waterfall(thumbnailRequests,
            function(err) {
                if (err) {
                    callback(err);
                } else {
                    callback(undefined);
                }
            });
    } else {
        callback();
    }
}



function getAnalysisScore(cellData) {
    if (cellData.analysis && cellData.analysis.images && cellData.analysis.images.length > 0) {
        var image = cellData.analysis.images[0];
        if (image && image.classifiers && image.classifiers.length > 0) {
            var classifier = cellData.analysis.images[0].classifiers[0]
            if (classifier && classifier.classes && classifier.classes.length > 0) {
                var classification = classifier.classes[0];
                return classification.score.toFixed(3);
            }
        }
    }
    return "-"
}





function recursiveDeleteFolderSync(path) {
    if (fs.existsSync(path)) {
        fs.readdirSync(path).forEach(function(file, index) {
            var curPath = path + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) {
                // recurse
                recursiveDeleteFolderSync(curPath);
            } else {
                // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(path);
    }
};

app.listen(appEnv.port, function() {
    // print a message when the server starts listening
    console.log("server starting on " + appEnv.url);
});