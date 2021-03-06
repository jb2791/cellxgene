import yaml

default_config = """
# cellxgene configuration

server:
  verbose: false
  debug: false
  host: "127.0.0.1"
  port : null
  scripts : []
  open_browser: false
  about_legal_tos: null
  about_legal_privacy: null
  force_https: false
  flask_secret_key: null
  generate_cache_control_headers: false

presentation:
  max_categories: 1000

multi_dataset:
  dataroot: null

  # The index page when in multi-dataset mode:
  #   false or null:  this returns a 404 code
  #   true:  loads a test index page, which links to the datasets that are available in the dataroot
  #   string/URL:  redirect to this URL:  flask.redirect(config.multi_dataset__index)
  index: false

  # A list of allowed matrix types.  If an empty list, then all matrix types are allowed
  allowed_matrix_types: []

  matrix_cache:
    # The maximum number of datasets that may be opened at one time.  The least recently used dataset
    # is evicted from the cache first.
    max_datasets: 5

    # A matrix is automatically removed from the cache after timelimit_s number of seconds.
    # If timelimit_s is set to None, then there is no time limit.
    timelimit_s: 30

single_dataset:
  datapath: null
  obs_names: null
  var_names: null
  about: null
  title: null

user_annotations:
  enable: true
  type: local_file_csv
  local_file_csv:
    directory: null
    file: null
  ontology:
    enable: false
    obo_location: null

embeddings:
  names : []
  enable_reembedding: false

diffexp:
  enable: true
  lfc_cutoff: 0.01

data_locator:
  s3:
    region_name: us-east-1

adaptor:
  cxg_adaptor:
    tiledb_ctx:
      sm.tile_cache_size:  8589934592
      sm.num_reader_threads:  32
      vfs.s3.region: us-east-1

  anndata_adaptor:
      backed: false

"""


def get_default_config():
    return yaml.load(default_config, Loader=yaml.Loader)
