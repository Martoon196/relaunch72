<?php
/**
 * Plugin Name:       Relaunch72 Publisher & SEO
 * Plugin URI:        https://app.relaunch72.com/
 * Description:       Site-configurable SEO (per-post SEO fields, title templates, robots, social previews, schema, sitemap control) that works alone or alongside Yoast SEO / Rank Math, plus a signed server-to-server connection that publishes owner-approved Relaunch72 articles as normal WordPress posts. Theme- and brand-independent.
 * Version:           1.1.1
 * Requires at least: 6.4
 * Requires PHP:      7.4
 * Author:            Relaunch72
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       relaunch72-publisher
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'R72PUB_VERSION', '1.1.1' );
define( 'R72PUB_PROTOCOL', 'r72-wordpress-1' );
define( 'R72PUB_URL_CONTRACT', 'wordpress-permalinks-1' );
define( 'R72PUB_MIN_WP', '6.4' );
define( 'R72PUB_MIN_PHP', '7.4' );
define( 'R72PUB_FILE', __FILE__ );
define( 'R72PUB_DIR', plugin_dir_path( __FILE__ ) );

require_once R72PUB_DIR . 'includes/class-r72pub-settings.php';
require_once R72PUB_DIR . 'includes/class-r72pub-signature.php';
require_once R72PUB_DIR . 'includes/class-r72pub-lock.php';
require_once R72PUB_DIR . 'includes/class-r72pub-capabilities.php';
require_once R72PUB_DIR . 'includes/class-r72pub-seo.php';
require_once R72PUB_DIR . 'includes/class-r72pub-media.php';
require_once R72PUB_DIR . 'includes/class-r72pub-publisher.php';
require_once R72PUB_DIR . 'includes/class-r72pub-rest.php';
require_once R72PUB_DIR . 'includes/class-r72pub-admin.php';
require_once R72PUB_DIR . 'includes/class-r72pub-metabox.php';

/**
 * Activation never touches posts, permalinks, SEO plugins or theme settings.
 * It only creates this site's stable connection identity if it does not exist.
 */
function r72pub_activate() {
	R72Pub_Settings::ensure_site_id();
}
register_activation_hook( __FILE__, 'r72pub_activate' );

/**
 * Deactivation keeps every post, attachment, category and SEO value.
 * Incoming writes simply stop because the REST routes are no longer registered.
 */
function r72pub_deactivate() {
	R72Pub_Lock::clear_all();
}
register_deactivation_hook( __FILE__, 'r72pub_deactivate' );

add_action( 'init', 'r72pub_load_textdomain' );
function r72pub_load_textdomain() {
	load_plugin_textdomain( 'relaunch72-publisher', false, dirname( plugin_basename( __FILE__ ) ) . '/languages' );
}
add_action( 'rest_api_init', array( 'R72Pub_Rest', 'register_routes' ) );
add_action( 'init', array( 'R72Pub_Seo', 'register_frontend' ) );
if ( is_admin() ) {
	R72Pub_Admin::init();
	R72Pub_Metabox::init();
}
