include ../../common.mk

.PHONY: clean
clean:
	rm -f artifact.zip
	rm -rf artifact.dir


# Build the ElasticBeanstalk configuration and deployment bundle,
# such that deployment can be done with a simple `eb deploy`.
# Presumes that a top-level `make build-client` has been done to 
# create the client static assets.

.PHONY: build
build: clean
	mkdir artifact.dir; \
	(cd ../.. ; \
	    git ls-files server/ | cpio -pdm server/eb/artifact.dir ; ); \
	$(call copy_client_assets,../../client/build,artifact.dir/server) ; \
	cp app.py artifact.dir/application.py; \
	cp ../requirements.txt artifact.dir; \
	cp -r .ebextensions artifact.dir; \
	if [ -f config.yaml ] ; then \
	  cp config.yaml artifact.dir;  \
	fi; \
	if [ -d static ] ; then \
	  mkdir -p artifact.dir/server/common/web/static/deploy; \
	  cp -r static/* artifact.dir/server/common/web/static/deploy;  \
	fi; \
	(cd artifact.dir; \
	  cp -r server/common/web/static static; \
	  zip -r ../artifact.zip . --exclude server/test/\* server/eb/\* ; ); \
	if ! grep artifact.zip .elasticbeanstalk/config.yml ; then \
	    mkdir -p .elasticbeanstalk ; cat config_deploy.yaml >> .elasticbeanstalk/config.yml ; fi

